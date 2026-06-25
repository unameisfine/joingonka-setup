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
 * Слияние не разрушает чужие данные: другие провайдеры/модели/ключи и
 * пользовательский top-level `model` сохраняются (deepMergeJson; model ставится
 * лишь при отсутствии).
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
import { deepMergeJson, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файлы конфига/ключей — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

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
 * Строит opencode.json, не разрушая чужие данные:
 *   - deep-merge нашего провайдера (модели сливаются по id) и $schema;
 *   - apiKey НЕ задаётся (ключ берётся из auth.json по provider-id);
 *   - top-level `model` — только если пользователь ещё не задал свой.
 */
function buildConfig(existing: JsonObject): JsonObject {
  const patch: JsonObject = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: OPENCODE_NPM,
        name: 'JoinGonka (Gonka)',
        options: {
          baseURL: BASE_URL_OPENAI,
        },
        models: buildModels(),
      },
    },
  };

  const merged = deepMergeJson(existing, patch);

  if (typeof merged.model !== 'string' || (merged.model as string).trim() === '') {
    merged.model = OPENCODE_DEFAULT_MODEL;
  }

  return merged;
}

/**
 * Строит auth.json: добавляет наш ключ под provider-id, сохраняя чужие записи.
 * Формат opencode для API-ключа: { "<id>": { "type": "api", "key": "<ключ>" } }.
 */
function buildAuth(existing: JsonObject, apiKey: string): JsonObject {
  return deepMergeJson(existing, {
    [OPENCODE_PROVIDER_ID]: { type: 'api', key: apiKey },
  });
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // 1) opencode.json — провайдер (без apiKey).
  const configPath = resolvePath(input.scope);
  const configBackup = backup(configPath);
  const config = buildConfig(parseObject(readRaw(configPath)));
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n', OWNER_ONLY_MODE);

  // 2) auth.json — ключ в нативном хранилище opencode (как `opencode auth login`).
  const authPath = resolveAuthPath();
  const authBackup = backup(authPath);
  const auth = buildAuth(parseObject(readRaw(authPath)), input.apiKey);
  await atomicWrite(authPath, JSON.stringify(auth, null, 2) + '\n', OWNER_ONLY_MODE);

  const messages = [
    `Configured provider in ${configPath}`,
    `Stored API key in ${authPath} (opencode native store — same as \`opencode auth login\`)`,
    `Base URL: ${BASE_URL_OPENAI}`,
    `Default model: ${OPENCODE_DEFAULT_MODEL}`,
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
