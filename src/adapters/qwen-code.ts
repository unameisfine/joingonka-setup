/**
 * Адаптер Qwen Code (https://github.com/QwenLM/qwen-code) — JSON с комментариями
 * ~/.qwen/settings.json, документированный «one-file setup».
 *
 * Что прописываем (OpenAI-режим, /v1/chat/completions):
 *   env.JOINGONKA_API_KEY            = "<литеральный ключ jg-…>"
 *   modelProviders.openai[]          += { id, name, baseUrl, envKey, generationConfig }
 *   security.auth.selectedType       = "openai"        ┐ только когда дефолтная
 *   model.name / model.baseUrl       = модель и шлюз   ┘ модель становится нашей
 *
 * ★ Первоисточники (сверено 21.09.2026, коммит 2800e9bb ветки main):
 *   docs/users/configuration/auth.md («Recommended: One-file setup via
 *     settings.json», таблица приоритетов env) —
 *     https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
 *   docs/users/configuration/model-providers.md (ModelConfig, generationConfig) —
 *     https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
 *   packages/core/src/models/types.ts        — ModelConfig, ModelGenerationConfig;
 *   packages/core/src/config/storage.ts      — QWEN_HOME, путь settings.json;
 *   packages/cli/src/config/environment.ts   — блок `env` файла → process.env;
 *   packages/core/src/providers/install.ts   — собственный /auth пишет `env.<KEY>`,
 *                                              `model.name` И парный `model.baseUrl`;
 *   packages/cli/src/config/settings.ts      — файл читается через
 *                                              strip-json-comments (комментарии — норма);
 *   packages/core/src/utils/envVarResolver.ts — `$VAR` в строках файла подставляется.
 *
 * ★ Ключ. Поля «apiKey» у записи модели в Qwen Code НЕТ: запись называет ИМЯ
 * переменной (`envKey`), а значение инструмент берёт из process.env. Но сам
 * settings.json умеет блок `env` — «stores API keys directly in settings.json»,
 * туда же кладёт ключи его собственный `/auth`. Поэтому ключ пишется литералом в
 * РОДНОЙ файл инструмента (0o600), а окружение оболочки и ~/.bashrc не трогаются.
 * Имя переменной уникальное (не общий OPENAI_API_KEY), чужим инструментам оно
 * ничего не меняет. Приоритет у Qwen Code: переменная оболочки > .env > блок
 * `env` — поэтому о другом значении JOINGONKA_API_KEY в окружении предупреждаем.
 *
 * ★ `modelProviders.openai` — ОБЩИЙ массив: в нём живут записи других шлюзов
 * пользователя. «Наши» — те, чей `baseUrl` указывает на наш шлюз. Правим
 * поэлементно: наши записи заменяем на месте, недостающие дописываем в конец —
 * значения чужих элементов и комментарии при этом целы (проверено на
 * jsonc-parser 3.3.1; меняются только отступы элемента, за которым идёт
 * вставка). Удалять элемент по индексу нельзя: библиотека портит
 * однострочные массивы и съедает комментарий за элементом (core/json-config.ts).
 * Поэтому редкий случай «наших записей было БОЛЬШЕ, чем моделей в сети» решается
 * заменой массива целиком: значения чужих записей сохраняются, комментарии
 * внутри этого массива — нет.
 *
 * ★ Лимиты. `generationConfig.contextWindowSize` — окно; потолок ответа —
 * `samplingParams.max_tokens` (другого поля нет). Побочный эффект, описанный в
 * доке: при заданном `samplingParams` конвейер не добавляет в запрос отдельный
 * блок `reasoning` (команда /effort для наших моделей не действует). Для шлюза
 * это плюс: вложенный `reasoning` ноды сети не понимают.
 *
 * ★ Дефолтная модель. Явный --model пишем всегда. Иначе всё решает
 * `security.auth.selectedType`:
 *   не задан или `qwen-oauth` — переводим на себя. Бесплатный тариф qwen-oauth
 *     закрыт 15.04.2026 (дока прямо велит переключаться), а без selectedType
 *     Qwen Code падает на тот же qwen-oauth — рабочим выбором это не является.
 *     Осознанно выбранную НАШУ актуальную модель при этом не меняем на дефолт;
 *   любой другой чужой тип (anthropic, gemini, vertex-ai) — не трогаем вовсе;
 *   `openai` — чужую модель не трогаем, нашу убранную заменяем, пустое заполняем.
 * Когда у пользователя что-то РЕАЛЬНО переключено (был другой тип или другая
 * модель), сообщение говорит, что именно и как вернуть (/auth либо бэкап).
 * `$version` не пишем: инструмент проставляет его сам при первом старте.
 *
 * Проектный `.qwen/settings.json` не поддерживаем: ключ в каталоге репозитория
 * — прямая дорога в git, а `modelProviders` проекта ЗАМЕНЯЕТ пользовательский.
 */
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
  type OpenClawModelSpec,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import type { JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  expandTilde,
  pathApi,
  type PathContext,
} from '../core/paths.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/** Имя переменной с ключом: блок `env` файла и `envKey` каждой нашей записи. */
const API_KEY_ENV = 'JOINGONKA_API_KEY';

/** Ключ `modelProviders` и значение `security.auth.selectedType` для OpenAI-совместимых API. */
const AUTH_TYPE = 'openai';

/** Закрытый 15.04.2026 бесплатный тариф: рабочим выбором не считается. */
const DISCONTINUED_AUTH_TYPE = 'qwen-oauth';

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
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
 * Путь к settings.json: <QWEN_HOME | ~/.qwen>/settings.json. QWEN_HOME — каталог;
 * ведущую `~` и относительный путь инструмент раскрывает сам (Storage.resolvePath),
 * повторяем. Окружение приходит параметром — чужая платформа проверяется тестом.
 */
export function qwenSettingsPath(ctx: PathContext = currentPathContext()): string {
  const { join, resolve } = pathApi(ctx);
  const custom = envValue(ctx, 'QWEN_HOME');
  const dir = custom !== undefined ? resolve(expandTilde(custom, ctx)) : join(ctx.home, '.qwen');
  return join(dir, 'settings.json');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function resolvePath(_scope: Scope): string {
  return qwenSettingsPath();
}

/** Адрес шлюза для сравнения: без хвостовых `/`, без регистра. */
function normalizeUrl(value: unknown): string | undefined {
  const text = asText(value);
  return text === undefined ? undefined : text.replace(/\/+$/, '').toLowerCase();
}

const OUR_URL = normalizeUrl(BASE_URL_OPENAI)!;

/** true — запись модели ведёт на наш шлюз (значит, ею управляет установщик). */
function isOurEntry(entry: unknown): boolean {
  return normalizeUrl(asObject(entry)?.baseUrl) === OUR_URL;
}

/**
 * Каталог установки: актуальные модели сети плюс явно запрошенная модель вне
 * каталога (сеть может получить модель раньше новой версии установщика; без
 * записи в `modelProviders` у Qwen Code для неё не будет ни адреса, ни ключа).
 * Лимиты незнакомой модели — осторожные.
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

/** Запись модели — поля `ModelConfig` (packages/core/src/models/types.ts). */
function modelEntry(spec: OpenClawModelSpec): JsonObject {
  return {
    id: spec.id,
    name: spec.name,
    baseUrl: BASE_URL_OPENAI,
    envKey: API_KEY_ENV,
    generationConfig: {
      contextWindowSize: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
      samplingParams: { max_tokens: spec.maxTokens },
    },
  };
}

/** Отказ с понятным текстом вместо сырого исключения jsonc-parser. */
function refuse(filePath: string, what: string): never {
  throw new Error(
    `${filePath}: ${what} Nothing was written — start Qwen Code once so it migrates the file ` +
      '(or fix it by hand) and run the installer again.',
  );
}

/**
 * Проверка формы узлов, ВНУТРЬ которых мы правим. Примитив или массив на пути
 * означает чужой/старый формат: V1 (`"model": "gpt-4"`) инструмент мигрирует сам
 * при старте, отменённую обёртку `{ protocol, models }` — тоже. Угадывать
 * миграцию за него не берёмся.
 */
function assertShape(settings: JsonObject, filePath: string): void {
  const objectPaths = [['env'], ['modelProviders'], ['security'], ['security', 'auth'], ['model']];
  for (const path of objectPaths) {
    let node: unknown = settings;
    for (const key of path) node = asObject(node)?.[key];
    if (node !== undefined && asObject(node) === undefined) {
      refuse(filePath, `"${path.join('.')}" is expected to be an object.`);
    }
  }
  const bucket = asObject(settings.modelProviders)?.[AUTH_TYPE];
  if (bucket !== undefined && !Array.isArray(bucket)) {
    refuse(filePath, `"modelProviders.${AUTH_TYPE}" is expected to be an array of models.`);
  }
}

/**
 * Правки общего массива `modelProviders.openai` (стратегия — в шапке файла):
 * наши записи заменяются на месте, недостающие дописываются в конец, и только
 * при избытке наших старых записей массив заменяется целиком.
 */
function planModelEdits(bucket: unknown, entries: JsonObject[]): JsonEdit[] {
  const base = ['modelProviders', AUTH_TYPE];
  if (!Array.isArray(bucket)) return [{ path: base, value: entries }];

  const ourIndexes = bucket.flatMap((entry, index) => (isOurEntry(entry) ? [index] : []));

  if (ourIndexes.length > entries.length) {
    let next = 0;
    const rebuilt = bucket.flatMap((entry) => {
      if (!isOurEntry(entry)) return [entry];
      return next < entries.length ? [entries[next++]] : [];
    });
    return [{ path: base, value: rebuilt }];
  }

  return entries.map((entry, position) => ({
    // Индекс -1 у jsonc-parser — «дописать в конец массива».
    path: [...base, position < ourIndexes.length ? ourIndexes[position]! : -1],
    value: entry,
  }));
}

/** id записей модели по всем провайдерам файла, разложенные на «наши» и «чужие». */
function declaredIds(settings: JsonObject): { ours: Set<string>; foreign: Set<string> } {
  const ours = new Set<string>();
  const foreign = new Set<string>();
  for (const bucket of Object.values(asObject(settings.modelProviders) ?? {})) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const id = asText(asObject(entry)?.id);
      if (id !== undefined) (isOurEntry(entry) ? ours : foreign).add(id);
    }
  }
  return { ours, foreign };
}

interface DefaultPlan {
  edits: JsonEdit[];
  /** Строка для пользователя о том, что стало (или осталось) дефолтом. */
  note: string;
  /** Что у пользователя БЫЛО и оказалось переключено; undefined — переключать было нечего. */
  switched?: { auth?: string; model?: string };
}

/** Решение по дефолтной модели (правила — в шапке файла). */
function planDefault(settings: JsonObject, input: ApplyInput): DefaultPlan {
  const model = asObject(settings.model);
  const currentName = asText(model?.name);
  const currentUrl = normalizeUrl(model?.baseUrl);
  const authType = asText(asObject(asObject(settings.security)?.auth)?.selectedType);

  // Наша ли выбранная модель? С парным baseUrl — однозначно. Без пары (старые
  // версии инструмента) — только если id объявлен под нашим шлюзом и больше
  // нигде: HF-подобные id (`deepseek-ai/…`) продают и другие шлюзы.
  const ids = declaredIds(settings);
  const isOurs =
    currentName !== undefined &&
    (currentUrl !== undefined
      ? currentUrl === OUR_URL
      : ids.ours.has(currentName) && !ids.foreign.has(currentName));
  const oursLive = isOurs && CANONICAL_IDS.includes(currentName!);
  const retiredNote =
    isOurs && !oursLive
      ? ` (replaces ${currentName}, which the Gonka network no longer serves)`
      : '';

  const takeOver = (name: string, why: string): DefaultPlan => {
    const auth = authType !== undefined && authType !== AUTH_TYPE ? authType : undefined;
    const previous = currentName !== undefined && currentName !== name ? currentName : undefined;
    return {
      edits: [
        { path: ['security', 'auth', 'selectedType'], value: AUTH_TYPE },
        { path: ['model', 'name'], value: name },
        // Парный baseUrl — как пишет сам инструмент: он различает одинаковые id
        // на разных шлюзах и не даёт старой паре увести выбор к чужому провайдеру.
        { path: ['model', 'baseUrl'], value: BASE_URL_OPENAI },
      ],
      note: `Default model: ${name}${why}`,
      switched: auth !== undefined || previous !== undefined ? { auth, model: previous } : undefined,
    };
  };
  const keep = (what: string): DefaultPlan => ({
    edits: [],
    note:
      `Kept your current default (${what}) — switch to a JoinGonka model inside Qwen Code ` +
      'with /model, or re-run with --model deepseek|glm|minimax.',
  });

  if (input.modelExplicit) return takeOver(input.model, '');

  if (authType === undefined || authType === DISCONTINUED_AUTH_TYPE) {
    const why =
      authType === DISCONTINUED_AUTH_TYPE
        ? ' (replaces qwen-oauth — that free tier was discontinued on 2026-04-15)'
        : retiredNote;
    return takeOver(oursLive ? currentName! : CODING_AGENT_DEFAULT_MODEL, why);
  }

  if (authType !== AUTH_TYPE) {
    // Рабочая чужая связка (anthropic, gemini, vertex-ai) — без --model не трогаем.
    return keep(
      currentName !== undefined
        ? `${currentName}, auth type "${authType}"`
        : `auth type "${authType}"`,
    );
  }

  if (currentName === undefined) return takeOver(CODING_AGENT_DEFAULT_MODEL, '');
  if (!isOurs) return keep(currentName);
  if (oursLive) return { edits: [], note: `Kept your current default model: ${currentName}` };
  return takeOver(CODING_AGENT_DEFAULT_MODEL, retiredNote);
}

/** «Что переключено и как вернуть» — только когда у пользователя что-то действительно заменено. */
function switchedLines(switched: DefaultPlan['switched'], backupPath: string | null): string[] {
  if (switched === undefined) return [];
  const was = [
    switched.auth !== undefined ? `auth type "${switched.auth}"` : undefined,
    switched.model !== undefined ? `default model "${switched.model}"` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' and ');
  return [
    `Switched Qwen Code to JoinGonka (auth type "${AUTH_TYPE}") — this replaced your previous ${was}.`,
    `To go back: run /auth (and /model) inside Qwen Code${
      backupPath != null ? `, or restore ${backupPath}` : ''
    }.`,
  ];
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const settingsPath = resolvePath(input.scope);

  // Qwen Code подставляет `$VAR` и `${VAR}` во ВСЕ строки settings.json
  // (envVarResolver.ts): ключ с такими символами он бы исказил. Настоящие ключи
  // jg-… — hex, так что это страховка, а не ограничение.
  if (/[$\s]/.test(input.apiKey)) {
    throw new Error(
      'The API key contains "$" or whitespace, which Qwen Code would rewrite when it loads ' +
        'settings.json. Nothing was written — check the key and run the installer again.',
    );
  }

  // Читаем, проверяем форму и считаем итоговый текст ДО бэкапа: любой отказ
  // оставляет диск нетронутым (ни записи, ни лишнего .bak).
  const doc = readJsonConfig(readRaw(settingsPath), settingsPath);
  assertShape(doc.value, settingsPath);

  const bucket = asObject(doc.value.modelProviders)?.[AUTH_TYPE];
  const defaults = planDefault(doc.value, input);
  const text = applyJsonEdits(
    doc.text,
    [
      { path: ['env', API_KEY_ENV], value: input.apiKey },
      ...planModelEdits(bucket, catalogFor(input).map(modelEntry)),
      ...defaults.edits,
    ],
    settingsPath,
  );

  const backupPath = backup(settingsPath);
  await atomicWrite(settingsPath, text, OWNER_ONLY_MODE);

  const messages = [
    `Configured ${settingsPath}`,
    `Base URL: ${BASE_URL_OPENAI}`,
    defaults.note,
    ...switchedLines(defaults.switched, backupPath),
    '',
    `Your API key was written into the "env" block of that file as ${API_KEY_ENV} (file mode 0600)`,
    "— Qwen Code's own place for keys. Your shell environment was not changed.",
    'Open /model in Qwen Code to switch between the JoinGonka models.',
    'Note: a project-level .qwen/settings.json that defines modelProviders replaces this list inside that project.',
  ];

  // Приоритет у инструмента: переменная оболочки > .env > блок env файла.
  const shadow = asText(process.env[API_KEY_ENV]);
  if (shadow !== undefined && shadow !== input.apiKey) {
    messages.push(
      '',
      `Warning: a different ${API_KEY_ENV} is set in your environment, and Qwen Code gives the`,
      'environment precedence over settings.json — unset it (or update it) to use the new key.',
    );
  }

  return { configPath: settingsPath, backupPath, wrote: true, messages };
}

export const qwenCodeAdapter: Adapter = {
  id: 'qwen-code',
  label: 'Qwen Code (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
