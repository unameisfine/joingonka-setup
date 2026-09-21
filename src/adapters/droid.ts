/**
 * Адаптер Factory Droid (https://factory.ai, CLI `droid`) — BYOK через
 * ~/.factory/settings.json (JSON с комментариями).
 *
 * Что прописываем (OpenAI-режим, /v1/chat/completions):
 *   customModels[] += { model, id, displayName, baseUrl, apiKey, provider,
 *                       maxOutputTokens, maxContextLimit, noImageSupport }
 *   sessionDefaultSettings.model = "custom:<model>" — только когда дефолтная
 *                                  модель становится нашей.
 *
 * ★ Первоисточники (сверено 21.09.2026):
 *   https://docs.factory.ai/model-independence/byok — файл, массив `customModels`,
 *     поля записи; `apiKey` — «Your API key for the provider», ссылка `${VAR}` —
 *     лишь возможность, литерал допустим; `provider` для Chat Completions —
 *     `generic-chat-completion-api`;
 *   https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control —
 *     «the same schema at every level»; там описаны `id` («Must start with
 *     custom:») и `maxContextLimit`;
 *   https://docs.factory.ai/droid-cli/settings — путь к файлу по платформам.
 *
 * ★ Где документация противоречит сама себе, решал сам инструмент. Страница
 * Settings называет ключом дефолта `model` верхнего уровня, схема Enterprise —
 * `sessionDefaultSettings.model`; формат id кастомной модели описан тремя
 * способами. CLI закрытый, поэтому спорные места сверены по СТРОКАМ официального
 * бинарника (встроенный минифицированный JS; файл НЕ запускался):
 *   версия  0.223.0, сборка linux/x64
 *   адрес   https://downloads.factory.ai/factory-cli/releases/0.223.0/linux/x64/droid
 *   sha256  bc7665c7e28d6f084589999688b8102524867a5a3e3c9e4646a5dd8dc80c74bd
 *           (совпал с опубликованным рядом файлом droid.sha256)
 * ⚠ Ключ дефолта `sessionDefaultSettings.model` подтверждён ПО БИНАРНИКУ, а не
 * по доке: дока называет два разных ключа и выбрать между ними не позволяет.
 * При выходе новой мажорной версии CLI сверку повторить; формат файла закреплён
 * golden-тестом в droid.test.ts. Что показал бинарник:
 *   - `getModel()` читает и пишет `sessionDefaultSettings.model`; схема файла —
 *     плоский объект с ключами `sessionDefaultSettings` и `customModels` в корне;
 *   - загрузчик `customModels` берёт `id` из записи, если это строка, иначе сам
 *     строит `custom:<DisplayName-через-дефисы>-<n>`, где n — номер записи среди
 *     записей С ТЕМ ЖЕ именем (не позиция в массиве); `index` без записи равен
 *     позиции; `maxContextLimit` читается; файл разбирается как JSON/JSONC;
 *   - ссылка разрешается по `id`, затем по полю `model` (`custom:<model>`).
 * Поэтому пишем явный `id: "custom:<model>"` — он совпадает и с прямым поиском
 * по id, и с запасным по `model`, и не зависит от имени и порядка записей.
 * `index` не пишем: инструмент подставит позицию сам, а чужие индексы мы не знаем.
 *
 * ★ Устаревший ключ `model` верхнего уровня учитываем ТОЛЬКО как выбор
 * пользователя (не перебиваем его своим дефолтом); сами пишем лишь в
 * подтверждённый `sessionDefaultSettings.model`.
 *
 * ★ `customModels` — ОБЩИЙ массив: в нём живут чужие модели пользователя.
 * «Наши» — записи с `baseUrl` нашего шлюза. Правим поэлементно: наши заменяем на
 * месте, недостающие дописываем в конец — значения чужих записей и комментарии
 * целы (меняются только отступы элемента, за которым идёт вставка). Удаление по
 * индексу запрещено (jsonc-parser 3.3.1 портит однострочные массивы и съедает
 * комментарий за элементом, см. core/json-config.ts), поэтому редкий случай
 * «наших записей было больше, чем моделей в сети» решается заменой массива
 * целиком: значения чужих записей сохраняются, комментарии внутри массива — нет.
 *
 * ★ Не пишем: `enableThinking`/`thinkingMaxTokens` (что именно уйдёт в запрос
 * для generic-провайдера, не подтверждено) и `modelFallbacks` — в CLI он
 * срабатывает, когда модель отсутствует в реестре или запрещена политикой, а не
 * при ошибке запроса, то есть от нехватки ёмкости сети не спасает.
 *
 * Путь один для обоих scope; переменной для переноса каталога у Droid нет.
 * Проектный `.factory/settings.json` не поддерживаем: ключ в репозитории.
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
import { currentPathContext, pathApi, type PathContext } from '../core/paths.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/** Тип провайдера для OpenAI Chat Completions (док BYOK, «Understanding providers»). */
const PROVIDER_TYPE = 'generic-chat-completion-api';

/** Префикс id кастомной модели («Must start with custom:»). */
const CUSTOM_PREFIX = 'custom:';

/** Заглушки ключа из примеров доки — записи с ними загрузчик CLI отбрасывает. */
const PLACEHOLDER_KEYS = ['YOUR_OPENAI_API_KEY', 'YOUR_API_KEY'];

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
 * Путь к settings.json: `~/.factory/settings.json`, на Windows —
 * `%USERPROFILE%\.factory\settings.json` (док Settings, «Where settings live»).
 * Окружение приходит параметром — чужая платформа проверяется тестом.
 */
export function droidSettingsPath(ctx: PathContext = currentPathContext()): string {
  return pathApi(ctx).join(ctx.home, '.factory', 'settings.json');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME). */
function resolvePath(_scope: Scope): string {
  return droidSettingsPath();
}

/** Адрес шлюза для сравнения: без хвостовых `/`, без регистра. */
function normalizeUrl(value: unknown): string | undefined {
  const text = asText(value);
  return text === undefined ? undefined : text.replace(/\/+$/, '').toLowerCase();
}

const OUR_URL = normalizeUrl(BASE_URL_OPENAI)!;

/** true — запись ведёт на наш шлюз (значит, ею управляет установщик). */
function isOurEntry(entry: unknown): boolean {
  return normalizeUrl(asObject(entry)?.baseUrl) === OUR_URL;
}

/** Ссылка на кастомную модель, которую мы пишем и в `id`, и в дефолт. */
function customRef(modelId: string): string {
  return `${CUSTOM_PREFIX}${modelId}`;
}

/**
 * Каталог установки: актуальные модели сети плюс явно запрошенная модель вне
 * каталога (без записи в `customModels` ссылка `custom:<model>` у Droid не
 * разрешится, и он молча уйдёт на свою модель). Лимиты незнакомой — осторожные.
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

/** Запись модели — поля схемы `customModels` (см. шапку). */
function modelEntry(spec: OpenClawModelSpec, apiKey: string): JsonObject {
  return {
    model: spec.id,
    id: customRef(spec.id),
    displayName: spec.name,
    baseUrl: BASE_URL_OPENAI,
    // Литерал, а не ${VAR}: ссылке нужна переменная в окружении Droid, а
    // установщик окружение не трогает.
    apiKey,
    provider: PROVIDER_TYPE,
    maxOutputTokens: spec.maxTokens,
    maxContextLimit: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    // Все модели сети — текстовые.
    noImageSupport: true,
  };
}

/** Существующая запись глазами загрузчика CLI: с тем id, под которым её знает Droid. */
interface KnownEntry {
  id: string;
  model: string;
  ours: boolean;
}

/**
 * Повторяет загрузчик `customModels` из CLI: какие записи он примет и какой id
 * даст тем, у кого своего нет. Нужно, чтобы понять, на ЧЬЮ запись указывает
 * нынешний дефолт — до того, как мы проставим своим записям явные id.
 */
function knownEntries(list: readonly unknown[]): KnownEntry[] {
  const seenNames = new Map<string, number>();
  const known: KnownEntry[] = [];
  for (const raw of list) {
    const entry = asObject(raw);
    if (!entry || typeof entry.model !== 'string' || typeof entry.provider !== 'string') continue;
    if (typeof entry.baseUrl !== 'string' && asObject(entry.bedrock) === undefined) continue;
    if (typeof entry.apiKey === 'string' && PLACEHOLDER_KEYS.includes(entry.apiKey)) continue;

    const displayName = typeof entry.displayName === 'string' ? entry.displayName : entry.model;
    const slug = displayName.trim().replace(/\s+/g, '-');
    const ordinal = seenNames.get(slug) ?? 0;
    seenNames.set(slug, ordinal + 1);

    known.push({
      id: typeof entry.id === 'string' ? entry.id : `${CUSTOM_PREFIX}${slug}-${ordinal}`,
      model: entry.model,
      ours: isOurEntry(entry),
    });
  }
  return known;
}

/** Разрешение ссылки как в CLI: сначала по id, затем по полю `model`. */
function resolveRef(ref: string, entries: readonly KnownEntry[]): KnownEntry | undefined {
  const bare = ref.slice(CUSTOM_PREFIX.length);
  return entries.find((e) => e.id === ref) ?? entries.find((e) => e.model === bare);
}

/** Отказ с понятным текстом вместо сырого исключения jsonc-parser. */
function refuse(filePath: string, what: string): never {
  throw new Error(
    `${filePath}: ${what} Nothing was written — fix the file (or move it aside) and run the installer again.`,
  );
}

/** Правки общего массива `customModels` (стратегия — в шапке файла). */
function planModelEdits(list: unknown, entries: JsonObject[]): JsonEdit[] {
  const base = ['customModels'];
  if (!Array.isArray(list)) return [{ path: base, value: entries }];

  const ourIndexes = list.flatMap((entry, index) => (isOurEntry(entry) ? [index] : []));

  if (ourIndexes.length > entries.length) {
    let next = 0;
    const rebuilt = list.flatMap((entry) => {
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

interface DefaultPlan {
  edits: JsonEdit[];
  /** Строка для пользователя о том, что стало (или осталось) дефолтом. */
  note: string;
}

/**
 * Решение по дефолтной модели: явный --model пишем всегда; иначе — только если
 * выбора нет или он указывает на НАШУ запись. Наша актуальная модель остаётся,
 * но ссылку приводим к явному id (прежний автогенерируемый перестанет
 * разрешаться); наша убранная — заменяется дефолтом. Модели Factory и чужие
 * кастомные не трогаем.
 */
function planDefault(settings: JsonObject, input: ApplyInput): DefaultPlan {
  const path = ['sessionDefaultSettings', 'model'];
  const setTo = (ref: string, why = ''): DefaultPlan => ({
    edits: [{ path, value: ref }],
    note: `Default model: ${ref}${why}`,
  });

  if (input.modelExplicit) return setTo(customRef(input.model));

  const current =
    asText(asObject(settings.sessionDefaultSettings)?.model) ?? asText(settings.model);
  if (current === undefined) return setTo(customRef(CODING_AGENT_DEFAULT_MODEL));

  const list = Array.isArray(settings.customModels) ? settings.customModels : [];
  const target = current.startsWith(CUSTOM_PREFIX)
    ? resolveRef(current, knownEntries(list))
    : undefined;

  if (!target?.ours) {
    return {
      edits: [],
      note:
        `Kept your current default model (${current}) — switch to a JoinGonka model inside ` +
        'Droid with /model, or re-run with --model deepseek|glm|minimax.',
    };
  }
  if (!CANONICAL_IDS.includes(target.model)) {
    return setTo(
      customRef(CODING_AGENT_DEFAULT_MODEL),
      ` (replaces ${target.model}, which the Gonka network no longer serves)`,
    );
  }
  const ref = customRef(target.model);
  return ref === current
    ? { edits: [], note: `Kept your current default model: ${current}` }
    : setTo(ref, ' (same model — the reference now uses the explicit id)');
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const settingsPath = resolvePath(input.scope);

  // `${VAR}` в apiKey Droid считает ссылкой на переменную окружения и при
  // незаданной переменной падает. Настоящие ключи jg-… — hex; это страховка.
  if (input.apiKey.includes('${') || /\s/.test(input.apiKey)) {
    throw new Error(
      'The API key contains "${" or whitespace, which Droid would treat as an environment ' +
        'reference. Nothing was written — check the key and run the installer again.',
    );
  }

  // Читаем, проверяем форму и считаем итоговый текст ДО бэкапа: любой отказ
  // оставляет диск нетронутым (ни записи, ни лишнего .bak).
  const doc = readJsonConfig(readRaw(settingsPath), settingsPath);
  const list = doc.value.customModels;
  if (list !== undefined && !Array.isArray(list)) {
    refuse(settingsPath, '"customModels" is expected to be an array.');
  }
  const sessionDefaults = doc.value.sessionDefaultSettings;
  if (sessionDefaults !== undefined && asObject(sessionDefaults) === undefined) {
    refuse(settingsPath, '"sessionDefaultSettings" is expected to be an object.');
  }

  const defaults = planDefault(doc.value, input);
  const entries = catalogFor(input).map((spec) => modelEntry(spec, input.apiKey));
  const text = applyJsonEdits(
    doc.text,
    [...planModelEdits(list, entries), ...defaults.edits],
    settingsPath,
  );

  const backupPath = backup(settingsPath);
  await atomicWrite(settingsPath, text, OWNER_ONLY_MODE);

  return {
    configPath: settingsPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${settingsPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      defaults.note,
      '',
      'Your API key was written into the custom model entries (file mode 0600, owner-only) —',
      'no environment variable needed. Droid picks up settings.json changes on its own.',
      'The JoinGonka models are listed under "Custom models" in /model.',
    ],
  };
}

export const droidAdapter: Adapter = {
  id: 'droid',
  label: 'Factory Droid (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
