/**
 * Адаптер opencode (https://opencode.ai) — JSON-конфиг ~/.config/opencode/opencode.json.
 *
 * opencode (репо anomalyco/opencode) настраивает кастомного провайдера через
 * `provider.<id>` с npm-адаптером `@ai-sdk/openai-compatible`:
 *   provider.joingonka = {
 *     npm: "@ai-sdk/openai-compatible",
 *     name: "JoinGonka (Gonka)",
 *     options: { baseURL: BASE_URL_OPENAI (С /v1), apiKey: "{env:GONKA_API_KEY}" },
 *     models: { "<id>": { name, limit:{context,output} } }
 *   }
 *   model (top-level) = "joingonka/moonshotai/Kimi-K2.6" — только если не задан.
 *
 * Почему файлом, а не интерактивно: документированный `/connect`→«Other» в
 * opencode сломан (issues #25991/#5937) — запись конфига это единственный
 * надёжный путь авто-настройки.
 *
 * ⚠️ Ключ jg-... в файл НЕ пишется: `apiKey` = `{env:GONKA_API_KEY}` (opencode
 *   подставляет из env), пользователю выдаётся `export GONKA_API_KEY=jg-...`.
 *
 * Слияние не разрушает чужие данные: другие провайдеры/модели и пользовательский
 * top-level `model` сохраняются (deepMergeJson; model ставится лишь при отсутствии).
 *
 * Путь: env OPENCODE_CONFIG (если задан) переопределяет; иначе global
 * ~/.config/opencode/opencode.json (XDG-style).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCODE_PROVIDER_ID,
  OPENCODE_NPM,
  OPENCODE_API_KEY_REF,
  OPENCODE_DEFAULT_MODEL,
  opencodeModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { deepMergeJson, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/**
 * Разрешение пути:
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

/** Каталог наших моделей в форме opencode: { "<id>": { name, limit } }. */
function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = opencodeModelEntry(spec) as JsonObject;
  }
  return models;
}

/**
 * Строит итоговый конфиг, не разрушая чужие данные:
 *   - deep-merge нашего провайдера (модели сливаются по id) и $schema;
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
          // apiKey = {env:GONKA_API_KEY} — opencode подставит из env, не литерал.
          apiKey: OPENCODE_API_KEY_REF,
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

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  const raw = readRaw(configPath);
  const backupPath = backup(configPath);

  let existing: JsonObject = {};
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as JsonObject;
      }
    } catch {
      existing = {}; // битый JSON → свежий объект (бэкап уже сделан)
    }
  }

  const config = buildConfig(existing);
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n', OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${OPENCODE_DEFAULT_MODEL}`,
      '',
      'Your API key is read from an environment variable (not stored in the config).',
      `Set it in your shell, then restart opencode:`,
      `  export GONKA_API_KEY=${input.apiKey}`,
      `To persist it, add that line to your ~/.bashrc or ~/.zshrc.`,
    ],
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
