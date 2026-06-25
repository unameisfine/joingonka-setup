/**
 * Адаптер Kilo Code (https://kilo.ai) — JSONC-конфиг ~/.config/kilo/kilo.jsonc.
 *
 * Новая (OpenCode-based) архитектура Kilo использует тот же формат кастомного
 * провайдера, что opencode (`@ai-sdk/openai-compatible`):
 *   provider.joingonka = { npm, name, options:{baseURL, apiKey:"{env:GONKA_API_KEY}"},
 *                          models:{ "<id>":{ name, tool_call, [reasoning], limit } } }
 *   model (top-level) = "joingonka/moonshotai/Kimi-K2.6" — только если не задан.
 *
 * Отличия от opencode: $schema = app.kilo.ai; модели несут `tool_call:true`
 * (Kilo требует нативный tool-calling) и `reasoning:true` для Kimi.
 *
 * Пишем чистый JSON в .jsonc-файл (JSON ⊂ JSONC, Kilo прочитает). Ключ jg-... в
 * файл НЕ пишется (`{env:GONKA_API_KEY}`). Слияние не разрушает чужие данные.
 *
 * Достоверность сверена с исходником Kilo (packages/opencode/src/config/config.ts,
 * 2026-06-25): глобальный loader ищет ["kilo.jsonc","kilo.json","opencode.jsonc",
 * "opencode.json","config.json"] в ~/.config/kilo/ — kilo.jsonc первый/дефолтный;
 * синтаксис {env:VAR} официально поддержан (пример {env:ANTHROPIC_API_KEY} в CLI-доке);
 * $schema https://app.kilo.ai/config.json штампуется loader'ом. GONKA_API_KEY —
 * УНИКАЛЬНОЕ имя (не общие OPENAI_ или ANTHROPIC_), соседние инструменты не трогает.
 * Нативная альтернатива env — store Kilo (`kilo auth login`, форк opencode-auth).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCODE_NPM,
  OPENCODE_API_KEY_REF,
  KILO_PROVIDER_ID,
  KILO_DEFAULT_MODEL,
  kiloModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { deepMergeJson, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

const OWNER_ONLY_MODE = 0o600;

function resolvePath(_scope: Scope): string {
  const fromEnv = process.env.KILO_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return join(homedir(), '.config', 'kilo', 'kilo.jsonc');
}

function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = kiloModelEntry(spec) as JsonObject;
  }
  return models;
}

function buildConfig(existing: JsonObject): JsonObject {
  const patch: JsonObject = {
    $schema: 'https://app.kilo.ai/config.json',
    provider: {
      [KILO_PROVIDER_ID]: {
        npm: OPENCODE_NPM,
        name: 'JoinGonka',
        options: {
          baseURL: BASE_URL_OPENAI,
          apiKey: OPENCODE_API_KEY_REF,
        },
        models: buildModels(),
      },
    },
  };

  const merged = deepMergeJson(existing, patch);

  if (typeof merged.model !== 'string' || (merged.model as string).trim() === '') {
    merged.model = KILO_DEFAULT_MODEL;
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
      existing = {};
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
      `Default model: ${KILO_DEFAULT_MODEL}`,
      '',
      // Ключ не в конфиге: kilo.jsonc ссылается на ИЗОЛИРОВАННУЮ переменную
      // GONKA_API_KEY через родной для Kilo синтаксис {env:...}. Имя уникально и
      // НЕ пересекается с общими OPENAI_*/ANTHROPIC_*, поэтому прочие инструменты
      // пользователя не затрагиваются. Дальше — на выбор: env или нативный store.
      "The config references an isolated env var GONKA_API_KEY (Kilo's native {env:} syntax),",
      'so your other OpenAI/Anthropic tools are left untouched. Provide the key either way:',
      `  - this shell session:  export GONKA_API_KEY=${input.apiKey}`,
      "  - or Kilo's own credential store (no env):  kilo auth login",
      'Then restart Kilo to pick up the provider.',
    ],
  };
}

export const kiloAdapter: Adapter = {
  id: 'kilo',
  label: 'Kilo Code (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
