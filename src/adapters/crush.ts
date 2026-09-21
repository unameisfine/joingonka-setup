/**
 * Адаптер Crush (Charm, https://github.com/charmbracelet/crush) — пользовательский
 * `crush.json` (СТРОГИЙ JSON).
 *
 * Что прописываем (OpenAI-режим, /v1/chat/completions):
 *   providers.joingonka = { name, type: "openai-compat", base_url (С /v1),
 *                           api_key: "<литеральный jg-…>", models: [ … ] }
 *   models.large / models.small = { model, provider: "joingonka" } — по правилам ниже.
 *
 * ★ Первоисточники (сверено 21.09.2026, коммит 17a62b72 ветки main, v0.96.1):
 *   README.md («Configuration», «Custom Providers») и docs/config/README.md
 *     («Where config lives», «Legacy JSON»);
 *   schema.json                  — ProviderConfig, Model, SelectedModel;
 *   internal/config/load.go      — порядок и приоритет файлов, GlobalConfig(),
 *                                  GlobalConfigData(), проверка `json.Valid`,
 *                                  правила кастомного провайдера и discover_models;
 *   internal/config/config.go    — поля ProviderConfig;
 *   internal/config/store.go     — выбор модели из интерфейса пишется в файл
 *                                  СОСТОЯНИЯ (`models.large`), права 0o600;
 *   internal/config/resolve.go   — `api_key` проходит shell-подстановку;
 *   internal/home/home.go        — каталог конфигов: XDG_CONFIG_HOME | ~/.config
 *                                  на всех платформах;
 *   internal/shellconfig/model.go — соответствие флагов цен полям модели;
 *   internal/agent/coordinator.go — reasoning_effort уходит в запрос только при
 *                                  заданных `reasoning_levels`;
 *   internal/ui/model/keys.go    — выбор модели: ctrl+l.
 *
 * ★ Почему crush.json, а не crushrc. С 27.07.2026 основной формат Crush —
 * `crushrc` (Bash со встроенными командами `provider add`, `model add`), а
 * crush.json объявлен устаревшим: «still supported… won't be receiving new
 * features». Но crushrc понимают только версии новее июля 2026, а JSON — все;
 * править чужой Bash-скрипт без его разбора и без гарантий сохранности мы не
 * умеем, тогда как JSON правится точечно (core/json-config). Оба файла Crush
 * сливает; при совпадении ключей верхнего уровня пишет предупреждение в лог и
 * отдаёт приоритет crushrc. Когда поддержку JSON уберут — адаптер переводить на
 * управляемый блок в crushrc.
 *
 * ★ Приоритет файлов (load.go, по возрастанию): /etc/crush/crush.json →
 * пользовательский crush.json → crushrc рядом с ним → файл СОСТОЯНИЯ
 * (~/.local/share/crush/crush.json) → конфиги проекта. В файл состояния Crush
 * сам записывает модель, выбранную в интерфейсе (`UpdatePreferredModel` →
 * `models.large`), — и она ПЕРЕКРЫВАЕТ и наш crush.json, и crushrc.
 *   Без --model файл состояния НЕ трогаем: это рабочий выбор пользователя.
 *     Вместо этого честно печатаем, какая модель останется действующей и как
 *     переключиться (ctrl+l). То же — если `model large …` закреплён в crushrc.
 *   С явным --model модель ОБЯЗАНА стать дефолтной, иначе флаг молча не
 *     действует. Поэтому, если выбор в файле состояния или в crushrc перекрыл бы
 *     нас, правим ТОЛЬКО `models.large` файла состояния — ту же запись тем же
 *     способом, что и сам Crush (целиком: max_tokens и think подбирались под
 *     прежнюю модель). Файл разбирается строго: битый → отказ «Nothing was
 *     written» до любой записи в ЛЮБОЙ из файлов; текст правки считается до
 *     бэкапа; права 0o600, как у Crush. Пользователю сообщаем, что и где
 *     изменено и где бэкап. Bash-скрипт crushrc не правим никогда — его
 *     перекрывает файл состояния.
 *
 * ★ Строгий JSON. Загрузчик делает `json.Valid` до разбора: комментарий или
 * висячая запятая — и Crush не стартует («invalid JSON in config file»). Читаем
 * мы терпимо (чтобы не потерять содержимое), пишем строго, а о комментариях в
 * существующем файле предупреждаем — сами их не вычищаем.
 *
 * ★ Модель: `context_window` — окно, `default_max_tokens` — потолок ответа,
 * цены — $ за 1M (живые от оркестратора, иначе фолбэк constants.ts);
 * `cost_per_1m_in_cached` — цена ЗАПИСИ в кеш, `cost_per_1m_out_cached` — цена
 * попадания (так их называет сам Crush: --price-cache-create / --price-cache-hit).
 * `reasoning_levels` не пишем: без них Crush не добавляет `reasoning_effort`.
 * `discover_models` не пишем: при непустом списке моделей автообнаружения нет.
 *
 * ★ Малая модель (заголовки, сводки) — MiniMax: без reasoning и самая ёмкая.
 * Ставим её, только когда large становится нашей в этой установке либо small
 * указывала на нашу убранную модель: подменять заголовки в чужой связке нельзя.
 */
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
  openclawModelEntry,
  type OpenClawModelSpec,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import {
  readJsonConfig,
  applyJsonEdits,
  type JsonConfigDoc,
  type JsonEdit,
} from '../core/json-config.js';
import type { JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  pathApi,
  xdgConfigHome,
  type PathContext,
} from '../core/paths.js';
import { priceFor, type LivePricing } from '../core/pricing.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id нашего провайдера в `providers` и в выборе модели. */
const PROVIDER_ID = 'joingonka';

/** Тип для «не-OpenAI провайдеров с OpenAI-совместимым API» (README, Custom Providers). */
const PROVIDER_TYPE = 'openai-compat';

/** Права на файл — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

const SCHEMA_URL = 'https://charm.land/crush.json';

/** Актуальные id моделей каталога — для сброса устаревшего выбора. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Непустая строка без пробелов по краям либо undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Пути Crush — как их считает load.go. `config` — файл, который пишем; `state` и
 * `crushrc` — только читаем. CRUSH_GLOBAL_CONFIG и CRUSH_GLOBAL_DATA — настоящие
 * переменные инструмента, обе задают КАТАЛОГ. Порядок для состояния повторяет
 * исходник: CRUSH_GLOBAL_DATA → XDG_DATA_HOME → (Windows) %LOCALAPPDATA% →
 * ~/.local/share. Окружение приходит параметром — чужая платформа проверяется тестом.
 */
export function crushPaths(ctx: PathContext = currentPathContext()): {
  config: string;
  state: string;
  crushrc: string;
} {
  const { join, dirname } = pathApi(ctx);
  const file = 'crush.json';

  const configDir = envValue(ctx, 'CRUSH_GLOBAL_CONFIG') ?? join(xdgConfigHome(ctx), 'crush');
  const config = join(configDir, file);

  let stateDir = envValue(ctx, 'CRUSH_GLOBAL_DATA');
  if (stateDir === undefined) {
    const xdgData = envValue(ctx, 'XDG_DATA_HOME');
    if (xdgData !== undefined) {
      stateDir = join(xdgData, 'crush');
    } else if (ctx.platform === 'win32') {
      const local =
        envValue(ctx, 'LOCALAPPDATA') ??
        join(envValue(ctx, 'USERPROFILE') ?? ctx.home, 'AppData', 'Local');
      stateDir = join(local, 'crush');
    } else {
      stateDir = join(ctx.home, '.local', 'share', 'crush');
    }
  }

  return { config, state: join(stateDir, file), crushrc: join(dirname(config), 'crushrc') };
}

/** Путь к crush.json; окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return crushPaths().config;
}

/**
 * Каталог установки: актуальные модели сети плюс явно запрошенная модель вне
 * каталога (выбор модели, которой нет у провайдера, Crush молча заменяет своим
 * дефолтом). Лимиты незнакомой модели — осторожные.
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
 * Справочная цена модели ($/1M): живая, если оркестратор её передал, иначе
 * фолбэк. Берём через `openclawModelEntry`, чтобы числа жили в одном месте
 * (constants.ts), а не дублировались здесь.
 */
function referenceCost(
  spec: OpenClawModelSpec,
  pricing: LivePricing | null | undefined,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const cost = asObject(openclawModelEntry(spec, priceFor(pricing, spec.id)).cost) ?? {};
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cost.cacheRead),
    cacheWrite: num(cost.cacheWrite),
  };
}

/** Запись модели — все поля, которые schema.json помечает обязательными. */
function modelEntry(spec: OpenClawModelSpec, pricing: LivePricing | null | undefined): JsonObject {
  const cost = referenceCost(spec, pricing);
  return {
    id: spec.id,
    name: spec.name,
    cost_per_1m_in: cost.input,
    cost_per_1m_out: cost.output,
    cost_per_1m_in_cached: cost.cacheWrite,
    cost_per_1m_out_cached: cost.cacheRead,
    context_window: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    default_max_tokens: spec.maxTokens,
    can_reason: spec.reasoning === true,
    // Все модели сети — текстовые.
    supports_attachments: false,
  };
}

/** Выбор модели в слоте large/small глазами установщика. */
interface Choice {
  /** `provider/model` — для сообщений и сравнения. */
  label: string;
  ours: boolean;
  /** Наша запись без модели либо с моделью, которой в сети уже нет. */
  stale: boolean;
}

/** Crush допускает неполную запись (только model или только provider) — это тоже выбор. */
function readChoice(value: unknown): Choice | undefined {
  const selection = asObject(value);
  const model = asText(selection?.model);
  const provider = asText(selection?.provider);
  if (model === undefined && provider === undefined) return undefined;
  const ours = provider === PROVIDER_ID;
  return {
    label: `${provider ?? '(default provider)'}/${model ?? '(default model)'}`,
    ours,
    stale: ours && (model === undefined || !CANONICAL_IDS.includes(model)),
  };
}

const ourSelection = (model: string): JsonObject => ({ model, provider: PROVIDER_ID });
const ourLabel = (model: string): string => `${PROVIDER_ID}/${model}`;

/** `model large <provider>/<id>` в crushrc; вызов без аргумента лишь печатает выбор. */
function crushrcLargeModel(raw: string | null): string | undefined {
  if (raw == null) return undefined;
  const matches = [...raw.matchAll(/^[ \t]*model[ \t]+large[ \t]+["']?([^\s"')]+\/[^\s"')]+)/gm)];
  // «Later lines win, just like a shell» — действует последняя строка.
  return matches.at(-1)?.[1];
}

/**
 * Файл состояния. При явном --model читаем СТРОГО: нам в него писать, и битый
 * файл означает отказ до любой записи. Без --model он нужен лишь для честного
 * сообщения — нечитаемый файл тогда не повод ронять установку.
 */
function readState(statePath: string, strict: boolean): JsonConfigDoc | undefined {
  try {
    const doc = readJsonConfig(readRaw(statePath), statePath);
    if (doc.value.models !== undefined && asObject(doc.value.models) === undefined) {
      refuse(statePath, '"models" is expected to be an object.');
    }
    return doc;
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
}

/** Отказ с понятным текстом вместо сырого исключения jsonc-parser. */
function refuse(filePath: string, what: string): never {
  throw new Error(
    `${filePath}: ${what} Nothing was written — fix the file (or move it aside) and run the installer again.`,
  );
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const { config: configPath, state: statePath, crushrc: crushrcPath } = crushPaths();

  // `api_key` Crush прогоняет через shell-подстановку ($VAR, $(cmd), кавычки).
  // Настоящие ключи jg-… — hex; всё остальное он бы исказил или исполнил.
  if (!/^[A-Za-z0-9._-]+$/.test(input.apiKey)) {
    throw new Error(
      'The API key contains characters that Crush would shell-expand when it loads crush.json. ' +
        'Nothing was written — check the key and run the installer again.',
    );
  }

  // Читаем, проверяем форму и считаем итоговый текст ДО бэкапа: любой отказ
  // оставляет диск нетронутым (ни записи, ни лишнего .bak).
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const providers = doc.value.providers;
  if (providers !== undefined && asObject(providers) === undefined) {
    refuse(configPath, '"providers" is expected to be an object.');
  }
  const ownProvider = asObject(providers)?.[PROVIDER_ID];
  if (ownProvider !== undefined && asObject(ownProvider) === undefined) {
    refuse(configPath, `"providers.${PROVIDER_ID}" is expected to be an object.`);
  }
  if (doc.value.models !== undefined && asObject(doc.value.models) === undefined) {
    refuse(configPath, '"models" is expected to be an object.');
  }

  const provider = ['providers', PROVIDER_ID];
  const edits: JsonEdit[] = [];
  const notes: string[] = [];

  if (typeof doc.value.$schema !== 'string') {
    edits.push({ path: ['$schema'], value: SCHEMA_URL });
  }
  edits.push(
    { path: [...provider, 'name'], value: 'JoinGonka (Gonka)' },
    { path: [...provider, 'type'], value: PROVIDER_TYPE },
    { path: [...provider, 'base_url'], value: BASE_URL_OPENAI },
    // Литерал, а не $VAR: ссылке нужна переменная в окружении Crush, а
    // установщик окружение не трогает.
    { path: [...provider, 'api_key'], value: input.apiKey },
    // Каталог — целиком актуальным набором: ушедшие из сети модели исчезают.
    {
      path: [...provider, 'models'],
      value: catalogFor(input).map((spec) => modelEntry(spec, input.pricing)),
    },
  );
  if (asObject(ownProvider)?.disable === true) {
    edits.push({ path: [...provider, 'disable'], value: undefined });
    notes.push(`Removed "disable": true from providers.${PROVIDER_ID} — the provider is active again.`);
  }

  // large: явный --model пишем всегда; иначе — только когда выбора нет или он
  // указывает на нашу убранную модель. Запись заменяем ЦЕЛИКОМ: max_tokens и
  // think подбирались под прежнюю модель.
  const models = asObject(doc.value.models);
  const large = readChoice(models?.large);
  const small = readChoice(models?.small);

  let largeLabel: string | undefined;
  let largeWritten = false;
  if (input.modelExplicit || large === undefined || large.stale) {
    const model = input.modelExplicit ? input.model : CODING_AGENT_DEFAULT_MODEL;
    edits.push({ path: ['models', 'large'], value: ourSelection(model) });
    largeLabel = ourLabel(model);
    largeWritten = true;
  } else if (large.ours) {
    largeLabel = large.label;
  }

  if (small?.stale || (small === undefined && largeWritten)) {
    edits.push({ path: ['models', 'small'], value: ourSelection(DEFAULT_MODEL) });
  }

  const text = applyJsonEdits(doc.text, edits, configPath);

  // Что перекрыло бы наш выбор (приоритет: состояние > crushrc > crush.json).
  // При явном --model файл состояния читается строго — битый означает отказ,
  // и происходит это ДО первого бэкапа и первой записи.
  const stateDoc = readState(statePath, input.modelExplicit === true);
  const fromState = readChoice(asObject(stateDoc?.value.models)?.large)?.label;
  const fromCrushrc = crushrcLargeModel(readRaw(crushrcPath));
  const override = fromState ?? fromCrushrc;
  const overridden =
    largeLabel !== undefined && override !== undefined && override !== largeLabel;

  // Явный --model обязан стать дефолтом: точечно правим `models.large` файла
  // состояния (он выше и crush.json, и crushrc). Текст — тоже до бэкапов.
  const stateText =
    overridden && input.modelExplicit
      ? applyJsonEdits(
          stateDoc?.text ?? '{}',
          [{ path: ['models', 'large'], value: ourSelection(input.model) }],
          statePath,
        )
      : undefined;

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  let stateBackup: string | null = null;
  if (stateText !== undefined) {
    stateBackup = backup(statePath);
    await atomicWrite(statePath, stateText, OWNER_ONLY_MODE);
  }

  const messages = [
    `Configured ${configPath}`,
    `Base URL: ${BASE_URL_OPENAI}`,
    largeLabel !== undefined
      ? `Large model: ${largeLabel}`
      : `Kept your large model: ${large!.label} — press ctrl+l inside Crush to pick a JoinGonka model, or re-run with --model deepseek|glm|minimax.`,
    ...notes,
  ];

  if (stateText !== undefined) {
    // Правили машинный файл — говорим прямо, что, где и как вернуть.
    messages.push(
      '',
      fromState !== undefined
        ? `Also set models.large in ${statePath} to ${largeLabel} (was ${override}).`
        : `Also set models.large in ${statePath} to ${largeLabel}: ${crushrcPath} pins "model large ${override}", and only that state file outranks crushrc.`,
      'Crush keeps the model picked in its UI in that file, and it overrides crush.json —',
      'without this change --model would have had no effect. Nothing else in the file was touched.',
      stateBackup != null
        ? `Previous state file backed up at ${stateBackup}`
        : 'The state file did not exist before — delete it to undo.',
    );
  } else if (overridden) {
    // Без --model чужой выбор не трогаем, но и не делаем вид, что дефолт наш.
    messages.push(
      '',
      `Heads-up: Crush will still start with ${override}, not ${largeLabel}.`,
      fromState !== undefined
        ? `The model you last picked in its UI is stored in ${statePath}, and that file overrides crush.json`
        : `${crushrcPath} sets "model large", and crushrc overrides crush.json`,
      fromState !== undefined
        ? '(it is your working choice, so the installer leaves it alone). Press ctrl+l inside Crush to pick'
        : '(the installer does not edit your shell config). Change that line, press ctrl+l inside Crush to pick',
      'the JoinGonka model, or re-run with --model deepseek|glm|minimax to make it the default.',
    );
  }

  try {
    JSON.parse(text);
  } catch {
    messages.push(
      '',
      'Warning: this crush.json contains comments or trailing commas. Crush only accepts strict JSON',
      '("invalid JSON in config file") — remove them, or Crush will refuse to start.',
    );
  }

  messages.push(
    '',
    'Your API key was written into the config (file mode 0600, owner-only) — no environment',
    'variable needed. Restart Crush to pick up the provider.',
  );

  return { configPath, backupPath, wrote: true, messages };
}

export const crushAdapter: Adapter = {
  id: 'crush',
  label: 'Crush (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  // В записи модели есть цена — Crush считает по ней стоимость сессии.
  wantsPricing: true,
  resolvePath,
  apply,
};
