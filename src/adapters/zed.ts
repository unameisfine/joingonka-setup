/**
 * Адаптер Zed (https://zed.dev) — JSONC settings.json (~/.config/zed на Linux и
 * macOS, %APPDATA%\Zed на Windows).
 *
 * Zed принимает кастомный OpenAI-совместимый провайдер декларативно:
 *   language_models.openai_compatible.<id> = {
 *     api_url, available_models: [ {name, display_name, max_tokens,
 *                                   max_output_tokens, capabilities} ]
 *   }
 *
 * ★ КЛЮЧ В ЭТОТ ФАЙЛ НЕ ПИШЕТСЯ — единственный адаптер-исключение из канона
 * «литеральный ключ в конфиг». Док Zed прямо запрещает: «Do not put API keys
 * in settings.json»; поля для ключа в схеме нет вообще. Zed берёт ключ из
 * своего UI-хранилища (keychain) либо из env-переменной, имя которой выводит
 * из id провайдера: upper snake case + `_API_KEY` (`joingonka` →
 * `JOINGONKA_API_KEY`). Поэтому адаптер пишет ТОЛЬКО провайдера и каталог
 * моделей (самая муторная часть), а ключ печатает двумя вариантами на выбор.
 *
 * ★ settings.json — ГЛАВНЫЙ конфиг редактора и почти всегда JSONC с
 * комментариями пользователя. Пишем через jsonc-parser (modify + applyEdits)
 * ТОЧЕЧНО по путям: комментарии, форматирование и все прочие настройки
 * (темы, LSP, кейбинды) остаются нетронутыми. JSON.parse/stringify здесь
 * недопустим — снёс бы комментарии.
 *
 * Путь один для обоих scope и зависит от платформы — см. zedSettingsPath.
 */
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  ZED_PROVIDER_ID,
  ZED_API_KEY_ENV,
  zedModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import type { JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  pathApi,
  xdgConfigHome,
  type PathContext,
} from '../core/paths.js';
import { staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Актуальные id моделей каталога — чтобы узнать ссылку на убранную модель. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Путь к settings.json. Сверено 21.09.2026 с докой Zed («Settings Files»,
 * https://zed.dev/docs/configuring-zed — исходник docs/src/configuring-zed.md) и
 * кодом crates/paths/src/paths.rs::config_dir:
 *   Windows: %APPDATA%\Zed\settings.json   (RoamingAppData + "Zed", с заглавной)
 *   Linux:   $XDG_CONFIG_HOME/zed/settings.json, иначе ~/.config/zed/settings.json
 *   macOS:   ~/.config/zed/settings.json — XDG_CONFIG_HOME Zed там НЕ читает
 *
 * До 0.4.5 путь был один на все платформы: на Windows конфиг писался в
 * ~/.config/zed, куда Zed не заглядывает, а на macOS с заданным XDG_CONFIG_HOME
 * — в каталог, которого Zed не знает. Flatpak-сборку (свой каталог через
 * FLATPAK_XDG_CONFIG_HOME внутри песочницы) снаружи не определить — не покрываем.
 *
 * Окружение приходит параметром, чтобы чужую платформу можно было проверить тестом.
 */
export function zedSettingsPath(ctx: PathContext = currentPathContext()): string {
  const { join } = pathApi(ctx);
  if (ctx.platform === 'win32') {
    const roaming = envValue(ctx, 'APPDATA') ?? join(ctx.home, 'AppData', 'Roaming');
    return join(roaming, 'Zed', 'settings.json');
  }
  const configHome = ctx.platform === 'darwin' ? join(ctx.home, '.config') : xdgConfigHome(ctx);
  return join(configHome, 'zed', 'settings.json');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function resolvePath(_scope: Scope): string {
  return zedSettingsPath();
}

/** Путь к нашему блоку провайдера внутри settings.json. */
const PROVIDER_PATH = ['language_models', 'openai_compatible', ZED_PROVIDER_ID];

/**
 * Настройки агента, где лежит выбор модели. Схема — crates/settings_content/
 * src/agent.rs (сверено 21.09.2026): одиночные — `LanguageModelSelection`
 * { provider, model, … }, списки — массивы таких же записей. Пример формы в доке:
 * https://zed.dev/docs/ai/agent-settings.
 */
const MODEL_SELECTION_KEYS = [
  'default_model',
  'subagent_model',
  'inline_assistant_model',
  'commit_message_model',
  'thread_summary_model',
  'compaction_model',
] as const;
const MODEL_LIST_KEYS = ['favorite_models', 'inline_alternatives'] as const;

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** true — запись выбирает НАШ провайдер и модель, которой в каталоге уже нет. */
function isStaleSelection(value: unknown): boolean {
  const selection = asObject(value);
  return (
    selection?.provider === ZED_PROVIDER_ID &&
    typeof selection.model === 'string' &&
    !CANONICAL_IDS.includes(selection.model)
  );
}

/**
 * Правки раздела `agent`: наша убранная модель в одиночных настройках
 * заменяется на `model` (меняем только поле `model` — соседние поля записи
 * вроде enable_thinking целы), из списков — выбрасывается. Чужие провайдеры не
 * трогаем, даже если имя их модели нам незнакомо.
 *
 * @param skipDefault default_model уже переписывается явным `--model`.
 */
function staleAgentEdits(
  agent: JsonObject,
  model: string,
  skipDefault: boolean,
): { edits: JsonEdit[]; staleRefs: number } {
  const edits: JsonEdit[] = [];
  let staleRefs = 0;

  for (const key of MODEL_SELECTION_KEYS) {
    if (!isStaleSelection(agent[key])) continue;
    staleRefs += 1;
    if (key === 'default_model' && skipDefault) continue;
    edits.push({ path: ['agent', key, 'model'], value: model });
  }

  for (const key of MODEL_LIST_KEYS) {
    const list = agent[key];
    if (!Array.isArray(list)) continue;
    const live = list.filter((entry) => !isStaleSelection(entry));
    if (live.length === list.length) continue;
    // Массив — целиком: удаление элементов по индексу в jsonc-parser 3.3.1
    // портит однострочные массивы (см. core/json-config.ts).
    edits.push({ path: ['agent', key], value: live });
    staleRefs += list.length - live.length;
  }

  return { edits, staleRefs };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Порядок: прочитать → посчитать итоговый текст → и только потом бэкап и
  // запись. Неразбираемый settings.json — отказ без записи: это ГЛАВНЫЙ конфиг
  // редактора (темы, LSP, кейбинды), и замена его свежим документом обошлась бы
  // пользователю дороже, чем ненастроенный провайдер. Так же — примитив на пути
  // правки (`"language_models": false`): чужое значение не затираем.
  const doc = readJsonConfig(readRaw(configPath), configPath);

  // Каталог моделей строим FRESH: устаревшие модели прошлых версий установщика
  // (напр. Qwen) исчезают, потому что массив заменяется целиком.
  const availableModels = OPENCLAW_MODELS.map((spec) => zedModelEntry(spec));

  // Точечные правки по путям — чужие настройки и КОММЕНТАРИИ файла целы.
  // Ключ (api_key) НЕ пишем: Zed его отсюда не читает и док это запрещает.
  const edits: JsonEdit[] = [
    { path: [...PROVIDER_PATH, 'api_url'], value: BASE_URL_OPENAI },
    { path: [...PROVIDER_PATH, 'available_models'], value: availableModels },
  ];

  // Явный --model доводим до конфига: до 0.4.5 флаг оставался только в тексте
  // подсказки, а live-проверка при этом «подтверждала» модель, которой в
  // настройках нет. Без явного флага выбор модели оставляем пользователю: в
  // Zed он делается в панели агента, и перебивать его молча нельзя.
  if (input.modelExplicit) {
    edits.push({
      path: ['agent', 'default_model'],
      value: { provider: ZED_PROVIDER_ID, model: input.model },
    });
  }

  // Модель, которой в сети больше нет, — не «выбор пользователя», а поломка:
  // Zed покажет её в панели и будет получать отказ на каждый запрос.
  const stale = staleAgentEdits(
    asObject(doc.value.agent) ?? {},
    input.model,
    input.modelExplicit === true,
  );
  edits.push(...stale.edits);
  const staleNote = staleRefsNote(stale.staleRefs);
  const text = applyJsonEdits(doc.text, edits, configPath);

  // Секретов в файле нет → права не форсим (write-file-atomic сохранит
  // существующие для уже созданного файла).
  const backupPath = backup(configPath);
  await atomicWrite(configPath, text);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Provider: ${ZED_PROVIDER_ID} → ${BASE_URL_OPENAI}`,
      `Models: ${OPENCLAW_MODELS.map((m) => m.id).join(', ')}`,
      ...(staleNote ? [staleNote] : []),
      '',
      // Единственный адаптер, который НЕ кладёт ключ в конфиг: так требует Zed.
      'Zed does NOT read API keys from settings.json, so the key was not written.',
      'Give Zed the key in either way:',
      `  1) export ${ZED_API_KEY_ENV}=${input.apiKey}`,
      '  2) or: agent panel → Settings → LLM Providers → paste it into the',
      `     "${ZED_PROVIDER_ID}" provider (stored in your OS keychain).`,
      '',
      `Then pick ${input.model} in the Agent Panel model selector.`,
      "Edit predictions (Zeta) stay on Zed's own models — a Zed limitation.",
    ],
  };
}

export const zedAdapter: Adapter = {
  id: 'zed',
  label: 'Zed (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
