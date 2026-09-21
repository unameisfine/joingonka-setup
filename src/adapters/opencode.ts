/**
 * Адаптер opencode (https://opencode.ai) — НАТИВНАЯ настройка БЕЗ env-переменных.
 *
 * Пишем два файла, ровно как делает сам opencode (`opencode auth login` → Other):
 *   1) ~/.config/opencode/opencode.json — описание провайдера `joingonka`
 *      (npm-адаптер @ai-sdk/openai-compatible, baseURL С /v1, models с limit).
 *      apiKey в options НЕ пишем — opencode подтягивает ключ из auth.json по
 *      совпадающему provider-id (apiKey опционален, см. docs/providers).
 *   2) ~/.local/share/opencode/auth.json — нативное хранилище ключей opencode:
 *      { "joingonka": { "type": "api", "key": "jg-..." } } — то же, что пишет
 *      `opencode auth login` → Other → <id> → <ключ>.
 *
 * Почему НЕ через env: opencode читает общие OPENAI_API_KEY / OPENAI_BASE_URL
 * для встроенного openai-провайдера. Перезапись этих переменных в ~/.bashrc /
 * ~/.zshrc уводит НА НАШ gateway ВСЕ прочие OpenAI-совместимые инструменты
 * пользователя (другой агент, скрипты) — ломает их. Нативный путь
 * (auth.json + изолированный provider-id) ничего постороннего не трогает.
 *
 * ⚠️ Provider-id `joingonka` в opencode.json и в auth.json ОБЯЗАН совпадать —
 *   требование opencode (иначе ключ не привяжется к провайдеру).
 *
 * Почему файлами, а не интерактивно: документированный `/connect`→«Other» в
 * opencode сломан (issues #25991/#5937), а `opencode auth login` интерактивен —
 * запись файлов это единственный надёжный путь авто-настройки в одну команду.
 *
 * ★ Правки ТОЧЕЧНЫЕ (core/json-config): меняем только свои пути. Чужие
 * провайдеры, чужие ключи в auth.json, комментарии и форматирование остаются
 * нетронутыми, а файл, который нельзя разобрать, приводит к отказу без записи
 * (до 0.4.5 такой файл заменялся свежим — с потерей ключей других провайдеров).
 *
 * Пути переопределяются env: OPENCODE_CONFIG → opencode.json,
 * OPENCODE_AUTH_JSON → auth.json (тесты и нестандартные раскладки XDG).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCODE_PROVIDER_ID,
  OPENCODE_NPM,
  OPENCODE_DEFAULT_MODEL,
  opencodeModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файлы конфига/ключей — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для прунинга устаревших и сброса дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Путь к opencode.json:
 *   1. env OPENCODE_CONFIG (trim, непустой) — приоритет;
 *   2. иначе ~/.config/opencode/opencode.json.
 * homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env).
 */
function resolvePath(_scope: Scope): string {
  const fromEnv = process.env.OPENCODE_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

/**
 * Путь к нативному хранилищу ключей opencode (auth.json):
 *   1. env OPENCODE_AUTH_JSON (trim, непустой) — приоритет;
 *   2. иначе ~/.local/share/opencode/auth.json (XDG data dir).
 */
function resolveAuthPath(): string {
  const fromEnv = process.env.OPENCODE_AUTH_JSON;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

/** Безопасный парс JSON-объекта; не-объект/битый → {} (бэкап делается отдельно). */
function parseObject(raw: string | null): JsonObject {
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    /* битый JSON → свежий объект */
  }
  return {};
}

/** Каталог наших моделей в форме opencode: { "<id>": { name, limit } }. */
function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = opencodeModelEntry(spec) as JsonObject;
  }
  return models;
}

/**
 * Точечные правки opencode.json: блок нашего провайдера (каталог моделей —
 * целиком актуальным набором) и top-level `model`.
 *
 * `model` пишем, если пользователь задал `--model` явно; иначе — только когда
 * он пуст или указывает на нашу убранную модель. Чужой выбор не трогаем.
 */
function buildEdits(existing: JsonObject, input: ApplyInput): { edits: JsonEdit[]; model: string } {
  const provider = ['provider', OPENCODE_PROVIDER_ID];
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://opencode.ai/config.json' },
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka (Gonka)' },
    // apiKey в options НЕ пишем: ключ живёт в нативном auth.json.
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    { path: [...provider, 'models'], value: buildModels() },
  ];

  const current = existing.model;
  const needsReset =
    typeof current !== 'string' ||
    current.trim() === '' ||
    isStaleProviderModelRef(current, OPENCODE_PROVIDER_ID, CANONICAL_IDS);

  let model: string;
  if (input.modelExplicit) {
    model = `${OPENCODE_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (needsReset) {
    model = OPENCODE_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current as string;
  }

  return { edits, model };
}

/**
 * Правка auth.json: добавляем наш ключ под provider-id, не касаясь чужих
 * записей. Формат opencode: { "<id>": { "type": "api", "key": "<ключ>" } }.
 */
function buildAuthEdits(apiKey: string): JsonEdit[] {
  return [
    { path: [OPENCODE_PROVIDER_ID, 'type'], value: 'api' },
    { path: [OPENCODE_PROVIDER_ID, 'key'], value: apiKey },
  ];
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // 1) opencode.json — провайдер (без apiKey). Читаем ДО бэкапа: неразбираемый
  //    конфиг означает отказ, и тогда диск не трогаем вовсе.
  const configPath = resolvePath(input.scope);
  const configDoc = readJsonConfig(readRaw(configPath), configPath);

  // 2) auth.json — ключ в нативном хранилище opencode. Тоже читаем заранее:
  //    в нём лежат ключи ДРУГИХ провайдеров пользователя.
  const authPath = resolveAuthPath();
  const authDoc = readJsonConfig(readRaw(authPath), authPath);

  const configBackup = backup(configPath);
  const { edits, model } = buildEdits(configDoc.value, input);
  await atomicWrite(configPath, applyJsonEdits(configDoc.text, edits), OWNER_ONLY_MODE);

  const authBackup = backup(authPath);
  await atomicWrite(
    authPath,
    applyJsonEdits(authDoc.text, buildAuthEdits(input.apiKey)),
    OWNER_ONLY_MODE,
  );

  const messages = [
    `Configured provider in ${configPath}`,
    `Stored API key in ${authPath} (opencode native store — same as \`opencode auth login\`)`,
    `Base URL: ${BASE_URL_OPENAI}`,
    `Default model: ${model}`,
    '',
    'No environment variables changed — your other OpenAI-compatible tools are left untouched.',
    'Restart opencode to pick up the new provider.',
  ];
  if (authBackup != null) {
    messages.push(`Previous auth.json backed up at ${authBackup}`);
  }

  return {
    configPath,
    backupPath: configBackup,
    wrote: true,
    messages,
  };
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  label: 'opencode (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
