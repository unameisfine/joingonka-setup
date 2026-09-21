/**
 * Адаптер MiMo Code (Xiaomi, https://github.com/XiaomiMiMo/MiMo-Code) — форк
 * OpenCode. Настройка НАТИВНАЯ, без env-переменных, двумя файлами — ровно то,
 * что делает собственный мастер инструмента «+ Custom provider»:
 *   1) <config>/mimocode.jsonc — провайдер `joingonka`
 *      (npm @ai-sdk/openai-compatible, options.baseURL С /v1, каталог моделей);
 *   2) <data>/auth.json — ключ: { "joingonka": { "type": "api", "key": "jg-…" } }.
 *
 * ★ Первоисточники (сверено 21.09.2026, коммит 47920126 ветки main):
 *   packages/shared/src/global.ts            — каталоги: MIMOCODE_HOME либо XDG;
 *   packages/opencode/src/config/config.ts   — имена и порядок глобальных файлов,
 *                                              MIMOCODE_CONFIG, top-level `model`,
 *                                              штамп `$schema`;
 *   packages/opencode/src/config/provider.ts — схема провайдера и записи модели;
 *   packages/opencode/src/auth/index.ts      — auth.json (формат, права 0o600);
 *   packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx
 *                                            — мастер: патч конфига + auth.set;
 *   packages/opencode/src/provider/provider.ts — ключ из auth.json подставляется,
 *                                              только если options.apiKey не задан.
 *
 * ★ Где лежат файлы. Задан MIMOCODE_HOME (обязан быть абсолютным — инструмент
 * на относительном падает) → <home>/config и <home>/data. Иначе каталоги из
 * npm-пакета `xdg-basedir`, без особого случая для Windows и macOS:
 *   конфиг: <XDG_CONFIG_HOME | ~/.config>/mimocode/
 *   ключи:  <XDG_DATA_HOME | ~/.local/share>/mimocode/auth.json
 * Глобальных конфигов три, инструмент сливает их по возрастанию приоритета:
 * config.json → mimocode.json → mimocode.jsonc. Пишем туда же, куда пишет он сам
 * (`globalConfigFile()`): в первый существующий из [mimocode.jsonc,
 * mimocode.json, config.json], а если нет ни одного — в mimocode.jsonc.
 * MIMOCODE_CONFIG — настоящая переменная инструмента: путь к файлу, который
 * грузится ПОВЕРХ глобальных; задана у пользователя — пишем в него.
 *
 * ★ Ключ — в auth.json, а не в `options.apiKey`: так делает сам инструмент, и
 * секрет не попадает в конфиг, который люди кладут в dotfiles. Поля `env` и
 * `setCacheKey`, которые добавляет мастер, НЕ пишем: первое — ссылка на
 * переменную окружения, второе добавляет в запрос `promptCacheKey`, которого
 * шлюз не знает. Устаревший `options.apiKey` в НАШЕМ блоке удаляем: он
 * перекрыл бы новый ключ из auth.json.
 *
 * ★ Правки ТОЧЕЧНЫЕ (core/json-config): чужие провайдеры, ключи, комментарии и
 * форматирование целы; неразбираемый файл или неожиданная форма узла → отказ
 * «Nothing was written» ДО бэкапа и ДО любой записи.
 */
import { existsSync } from 'node:fs';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
  OPENCODE_NPM,
  type OpenClawModelSpec,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  pathApi,
  xdgConfigHome,
  xdgDataHome,
  type PathContext,
} from '../core/paths.js';
import { opencodeStaleRefEdits, staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id нашего провайдера — один и тот же в конфиге и в auth.json (требование инструмента). */
const PROVIDER_ID = 'joingonka';

/** Права на файлы конфига и ключей — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/** `$schema`, который инструмент сам штампует в глобальный конфиг. */
const SCHEMA_URL = 'https://mimo.xiaomi.com/mimocode/config.json';
/** Схема opencode — её инструмент считает «чужой» и заменяет на свою. */
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/** Глобальные конфиги по УБЫВАНИЮ приоритета (он же порядок выбора файла для записи). */
const CONFIG_FILE_NAMES = ['mimocode.jsonc', 'mimocode.json', 'config.json'] as const;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Пути MiMo Code (см. шапку). Окружение приходит параметром — так ветки
 * MIMOCODE_HOME, XDG и чужой платформы проверяются тестами на любой машине.
 */
export function mimoCodePaths(ctx: PathContext = currentPathContext()): {
  config: string;
  auth: string;
  configDir: string;
} {
  const { join, isAbsolute } = pathApi(ctx);
  const home = envValue(ctx, 'MIMOCODE_HOME');
  if (home !== undefined && !isAbsolute(home)) {
    // Так же падает сам инструмент (resolveMimocodeHome): писать в каталог,
    // который он не примет, бессмысленно.
    throw new Error(
      `MIMOCODE_HOME must be an absolute path, got: ${JSON.stringify(home)}. ` +
        'Nothing was written — fix the variable and run the installer again.',
    );
  }

  const configDir = home !== undefined ? join(home, 'config') : join(xdgConfigHome(ctx), 'mimocode');
  const dataDir = home !== undefined ? join(home, 'data') : join(xdgDataHome(ctx), 'mimocode');

  const custom = envValue(ctx, 'MIMOCODE_CONFIG');
  const existing = CONFIG_FILE_NAMES.map((name) => join(configDir, name)).find((file) =>
    existsSync(file),
  );

  return {
    config: custom ?? existing ?? join(configDir, CONFIG_FILE_NAMES[0]),
    auth: join(dataDir, 'auth.json'),
    configDir,
  };
}

/** Путь к конфигу; окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return mimoCodePaths().config;
}

/**
 * Каталог установки: актуальные модели сети плюс явно запрошенная модель вне
 * каталога. Сеть может получить модель раньше, чем выйдет новая версия
 * установщика; дефолт, которого нет в каталоге провайдера, инструмент молча
 * отбрасывает («configured default model missing from registry»). Лимиты для
 * незнакомой модели — осторожные: окно по умолчанию и наименьший потолок ответа.
 */
function catalogFor(input: ApplyInput): OpenClawModelSpec[] {
  const specs = [...OPENCLAW_MODELS];
  if (input.modelExplicit && !CANONICAL_IDS.includes(input.model)) {
    specs.push({
      id: input.model,
      name: input.model,
      maxTokens: Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens)),
    });
  }
  return specs;
}

/**
 * Запись модели: `{ name, tool_call, [reasoning], limit: { context, output } }`
 * — поля схемы `Model` (config/provider.ts). `limit` обязателен: без него
 * инструмент берёт окно по умолчанию и пишет предупреждение. `reasoning:true`
 * для наших id ничего не добавляет в запрос: `ProviderTransform.variants`
 * возвращает пусто для glm/minimax и для deepseek вне провайдера `deepseek`.
 */
function modelEntry(spec: OpenClawModelSpec): JsonObject {
  const entry: JsonObject = {
    name: spec.name,
    tool_call: true,
    limit: { context: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens },
  };
  if (spec.reasoning) entry.reasoning = true;
  return entry;
}

/**
 * Отказ с понятным текстом, если на пути нашей правки стоит не объект.
 * jsonc-parser в этом случае бросает сырое «Can not add index to parent of type
 * string» — уже ПОСЛЕ того, как адаптер мог сделать бэкап.
 */
function expectObjects(root: JsonObject, path: readonly string[], filePath: string): void {
  let node: unknown = root;
  for (let depth = 0; depth < path.length; depth++) {
    node = (node as JsonObject)[path[depth]!];
    if (node === undefined) return;
    if (asObject(node) === undefined) {
      throw new Error(
        `${filePath}: "${path.slice(0, depth + 1).join('.')}" is expected to be an object. ` +
          'Nothing was written — fix the file (or move it aside) and run the installer again.',
      );
    }
  }
}

/**
 * `model` из остальных глобальных конфигов — только чтение. Инструмент сливает
 * файлы, поэтому модель из нижнего файла действует, пока целевой её не задаёт;
 * записать туда свою значило бы молча перебить выбор пользователя. Все прочие
 * файлы по приоритету НИЖЕ целевого: целевой — первый существующий по убыванию
 * приоритета либо слой MIMOCODE_CONFIG поверх всех.
 */
function inheritedModel(targetPath: string, configDir: string, ctx: PathContext): string | undefined {
  const { join } = pathApi(ctx);
  for (const name of CONFIG_FILE_NAMES) {
    const file = join(configDir, name);
    if (file === targetPath) continue;
    try {
      const model = readJsonConfig(readRaw(file), file).value.model;
      if (typeof model === 'string' && model.trim() !== '') return model;
    } catch {
      // Не наш адресат: не разобрался — просто не учитываем.
    }
  }
  return undefined;
}

interface ConfigPlan {
  edits: JsonEdit[];
  /** Модель, которая фактически окажется дефолтной (для сообщения пользователю). */
  model: string;
  staleRefs: number;
  notes: string[];
}

/** Точечные правки конфига: блок провайдера, дефолтная модель, устаревшие ссылки. */
function planConfig(existing: JsonObject, inherited: string | undefined, input: ApplyInput): ConfigPlan {
  const provider = ['provider', PROVIDER_ID];
  const edits: JsonEdit[] = [];
  const notes: string[] = [];

  // `$schema` — как сам инструмент: ставим, если его нет или он от opencode.
  if (typeof existing.$schema !== 'string' || existing.$schema === OPENCODE_SCHEMA_URL) {
    edits.push({ path: ['$schema'], value: SCHEMA_URL });
  }

  const models: JsonObject = {};
  for (const spec of catalogFor(input)) models[spec.id] = modelEntry(spec);
  edits.push(
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka (Gonka)' },
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    // Каталог — целиком актуальным набором: ушедшие из сети модели исчезают.
    { path: [...provider, 'models'], value: models },
  );

  // Старый ключ в НАШЕМ блоке перекрыл бы ключ из auth.json (provider.ts:
  // `if (options.apiKey === undefined && provider.key) …`).
  const ownOptions = asObject(asObject(asObject(existing.provider)?.[PROVIDER_ID])?.options);
  if (ownOptions && 'apiKey' in ownOptions) {
    edits.push({ path: [...provider, 'options', 'apiKey'], value: undefined });
    notes.push(
      `Removed provider.${PROVIDER_ID}.options.apiKey from the config — it would override the key in auth.json.`,
    );
  }

  // Пользователь ограничил список провайдеров — без нас в нём провайдер не поднимется.
  const enabled = existing.enabled_providers;
  if (Array.isArray(enabled) && !enabled.includes(PROVIDER_ID)) {
    edits.push({ path: ['enabled_providers', -1], value: PROVIDER_ID });
  }
  const disabled = existing.disabled_providers;
  if (Array.isArray(disabled) && disabled.includes(PROVIDER_ID)) {
    // Осознанный запрет пользователя молча не снимаем — говорим о нём.
    notes.push(
      `Note: "${PROVIDER_ID}" is listed in disabled_providers, so MiMo Code will ignore it until you remove it from that list.`,
    );
  }

  // Дефолтная модель: явный --model пишем всегда; иначе — только когда её нет
  // или она указывает на нашу убранную модель. Чужой выбор не трогаем.
  const own = existing.model;
  const current = typeof own === 'string' && own.trim() !== '' ? own : inherited;
  const ourDefault = `${PROVIDER_ID}/${CODING_AGENT_DEFAULT_MODEL}`;
  const staleDefault = isStaleProviderModelRef(current, PROVIDER_ID, CANONICAL_IDS);

  let model: string;
  if (input.modelExplicit) {
    model = `${PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (current === undefined || staleDefault) {
    model = ourDefault;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current;
  }

  // Наши убранные модели ВНЕ каталога: small_model, модели агентов и команд
  // (формат у форка тот же, что у opencode — config.ts, agent.ts, command.ts).
  const replacement = input.modelExplicit ? `${PROVIDER_ID}/${input.model}` : ourDefault;
  const staleEdits = opencodeStaleRefEdits(existing, PROVIDER_ID, CANONICAL_IDS, replacement);
  edits.push(...staleEdits);

  return { edits, model, staleRefs: staleEdits.length + (staleDefault ? 1 : 0), notes };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const ctx = currentPathContext();
  const { config: configPath, auth: authPath, configDir } = mimoCodePaths(ctx);

  // Оба файла читаем и ОБА текста правок считаем ДО бэкапа и ДО первой записи:
  // любой отказ (битый файл, неожиданная форма узла) оставляет диск нетронутым.
  const configDoc = readJsonConfig(readRaw(configPath), configPath);
  const authDoc = readJsonConfig(readRaw(authPath), authPath);
  // Проверяем только узлы, ВНУТРЬ которых правим; `models` и запись в auth.json
  // заменяются целиком, и их прежняя форма нам безразлична.
  expectObjects(configDoc.value, ['provider', PROVIDER_ID, 'options'], configPath);

  const plan = planConfig(configDoc.value, inheritedModel(configPath, configDir, ctx), input);
  const configText = applyJsonEdits(configDoc.text, plan.edits, configPath);
  // Свою запись в auth.json ставим целиком: прежнее значение (oauth, мусор) нам
  // не нужно, а чужие записи правка не адресует.
  const authText = applyJsonEdits(
    authDoc.text,
    [{ path: [PROVIDER_ID], value: { type: 'api', key: input.apiKey } }],
    authPath,
  );

  const configBackup = backup(configPath);
  await atomicWrite(configPath, configText, OWNER_ONLY_MODE);
  const authBackup = backup(authPath);
  await atomicWrite(authPath, authText, OWNER_ONLY_MODE);

  const staleNote = staleRefsNote(plan.staleRefs);
  const messages = [
    `Configured provider in ${configPath}`,
    `Stored API key in ${authPath} (MiMo Code native key store, file mode 0600)`,
    `Base URL: ${BASE_URL_OPENAI}`,
    plan.model.startsWith(`${PROVIDER_ID}/`)
      ? `Default model: ${plan.model}`
      : `Kept your default model: ${plan.model} — pick a JoinGonka model inside MiMo Code with /models, or re-run with --model deepseek|glm|minimax.`,
    ...(staleNote ? [staleNote] : []),
    ...plan.notes,
    '',
    'No environment variables changed — your other OpenAI-compatible tools are left untouched.',
    'Restart MiMo Code (`mimo`) to pick up the new provider.',
  ];
  if (authBackup != null) {
    messages.push(`Previous auth.json backed up at ${authBackup}`);
  }

  return { configPath, backupPath: configBackup, wrote: true, messages };
}

export const mimoCodeAdapter: Adapter = {
  id: 'mimo-code',
  label: 'MiMo Code (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
