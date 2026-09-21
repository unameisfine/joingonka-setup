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
  ZED_PROVIDER_ID,
  ZED_API_KEY_ENV,
  zedModelEntry,
} from '../constants.js';
import { catalogFor, catalogIds } from '../core/catalog.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { asObject } from '../core/json-shape.js';
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
 * Как передать Zed ключ — в settings.json его класть нельзя, поэтому печатаем два
 * пути: переменная окружения либо хранилище ключей из интерфейса Zed.
 *
 * Команда для переменной зависит от ПЛАТФОРМЫ: `export` есть только в POSIX-
 * оболочках. До 0.5.0 он печатался и на Windows, где его нет ни в PowerShell, ни
 * в cmd, — человек копировал строку и получал ошибку. На Windows даём оба
 * штатных способа: `$env:` (PowerShell, только текущее окно — Zed надо запустить
 * из него же) и `setx` (переменная пользователя, постоянная; уже открытых окон и
 * программ не касается — поэтому Zed после неё перезапускается).
 *
 * Окружение приходит параметром (как у путей, core/paths.ts) — Windows-ветка
 * проверяется тестом на любой машине.
 */
export function zedKeyInstructions(
  apiKey: string,
  ctx: PathContext = currentPathContext(),
): string[] {
  const viaEnv =
    ctx.platform === 'win32'
      ? [
          '  1) an environment variable — in PowerShell:',
          `       $env:${ZED_API_KEY_ENV} = "${apiKey}"    (this window only — start Zed from it)`,
          `       setx ${ZED_API_KEY_ENV} "${apiKey}"      (permanent — for programs started afterwards,`,
          '                                                so open a new terminal and restart Zed)',
        ]
      : [`  1) export ${ZED_API_KEY_ENV}=${apiKey}`];
  return [
    'Give Zed the key in either way:',
    ...viaEnv,
    '  2) or: agent panel → Settings → LLM Providers → paste it into the',
    `     "${ZED_PROVIDER_ID}" provider (stored in your OS keychain).`,
  ];
}

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

/**
 * true — запись выбирает НАШ провайдер и модель, которой нет в каталоге ЭТОЙ
 * установки (`liveIds` — core/catalog.ts: сеть плюс явно запрошенная вне каталога).
 */
function isStaleSelection(value: unknown, liveIds: readonly string[]): boolean {
  const selection = asObject(value);
  return (
    selection?.provider === ZED_PROVIDER_ID &&
    typeof selection.model === 'string' &&
    !liveIds.includes(selection.model)
  );
}

/**
 * Правки раздела `agent`: наша убранная модель в одиночных настройках
 * заменяется на `model` (меняем только поле `model` — соседние поля записи
 * вроде enable_thinking целы), из списков — выбрасывается. Чужие провайдеры не
 * трогаем, даже если имя их модели нам незнакомо.
 *
 * @param skipDefault default_model уже переписывается явным `--model`.
 * @param liveIds     id моделей каталога этой установки (core/catalog.ts).
 */
function staleAgentEdits(
  agent: JsonObject,
  model: string,
  skipDefault: boolean,
  liveIds: readonly string[],
): { edits: JsonEdit[]; staleRefs: number } {
  const edits: JsonEdit[] = [];
  let staleRefs = 0;

  for (const key of MODEL_SELECTION_KEYS) {
    if (!isStaleSelection(agent[key], liveIds)) continue;
    staleRefs += 1;
    if (key === 'default_model' && skipDefault) continue;
    edits.push({ path: ['agent', key, 'model'], value: model });
  }

  for (const key of MODEL_LIST_KEYS) {
    const list = agent[key];
    if (!Array.isArray(list)) continue;
    const live = list.filter((entry) => !isStaleSelection(entry, liveIds));
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
  // (напр. Qwen) исчезают, потому что массив заменяется целиком. Явно запрошенная
  // модель вне каталога тоже попадает в него (core/catalog.ts): default_model,
  // которого нет в available_models, Zed в панели агента не покажет.
  const catalog = catalogFor(input);
  const availableModels = catalog.map((spec) => zedModelEntry(spec));

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
    catalogIds(input),
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
      `Models: ${catalog.map((m) => m.id).join(', ')}`,
      ...(staleNote ? [staleNote] : []),
      '',
      // Единственный адаптер, который НЕ кладёт ключ в конфиг: так требует Zed.
      'Zed does NOT read API keys from settings.json, so the key was not written.',
      ...zedKeyInstructions(input.apiKey),
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
