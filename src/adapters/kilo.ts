/**
 * Адаптер Kilo Code (https://kilo.ai) — JSONC-конфиг ~/.config/kilo/kilo.jsonc.
 *
 * Новая (OpenCode-based) архитектура Kilo использует тот же формат кастомного
 * провайдера, что opencode (`@ai-sdk/openai-compatible`):
 *   provider.joingonka = { npm, name, options:{baseURL, apiKey:"<литеральный jg-...>"},
 *                          models:{ "<id>":{ name, tool_call, [reasoning], limit } } }
 *   model (top-level) = "joingonka/moonshotai/Kimi-K2.6" — только если не задан.
 *
 * Отличия от opencode: $schema = app.kilo.ai; модели несут `tool_call:true`
 * (Kilo требует нативный tool-calling) и `reasoning:true` для Kimi.
 *
 * Пишем чистый JSON в .jsonc-файл (JSON ⊂ JSONC, Kilo прочитает). Ключ jg-... пишем
 * ЛИТЕРАЛОМ в файл (0o600, owner-only) — env не нужен (раньше была {env:GONKA_API_KEY},
 * но без экспортированной переменной провайдер не поднимался). Слияние не разрушает чужие данные.
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
  KILO_PROVIDER_ID,
  KILO_DEFAULT_MODEL,
  kiloModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { deepMergeJson, isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для прунинга устаревших и сброса дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

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

function buildConfig(existing: JsonObject, apiKey: string): JsonObject {
  const patch: JsonObject = {
    $schema: 'https://app.kilo.ai/config.json',
    provider: {
      [KILO_PROVIDER_ID]: {
        npm: OPENCODE_NPM,
        name: 'JoinGonka',
        options: {
          baseURL: BASE_URL_OPENAI,
          // Литеральный ключ jg-... (НЕ {env:...}-ссылка): без env-формы Kilo берёт
          // значение как есть → работает БЕЗ внешней переменной. Раньше тут была
          // {env:GONKA_API_KEY}, и без экспортированной переменной провайдер не
          // поднимался. Файл пишется 0o600 (owner-only).
          apiKey,
        },
        models: buildModels(),
      },
    },
  };

  const merged = deepMergeJson(existing, patch);

  // Наш провайдер — единственный источник правды по СВОЕМУ каталогу: заменяем
  // models ЦЕЛИКОМ актуальным набором, чтобы убрать устаревшие модели (напр. Qwen),
  // оставшиеся от прошлых версий установщика.
  const ourProvider = asObject(asObject(merged.provider)?.[KILO_PROVIDER_ID]);
  if (ourProvider) ourProvider.models = buildModels();

  // top-level `model`: наш дефолт, если не задан ИЛИ указывает на нашу убранную
  // модель. Пользовательский дефолт на чужой провайдер или на актуальную нашу
  // модель — НЕ трогаем.
  if (
    typeof merged.model !== 'string' ||
    (merged.model as string).trim() === '' ||
    isStaleProviderModelRef(merged.model, KILO_PROVIDER_ID, CANONICAL_IDS)
  ) {
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

  const config = buildConfig(existing, input.apiKey);
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
      // Ключ записан ЛИТЕРАЛЬНО в kilo.jsonc (0o600). Раньше писали {env:GONKA_API_KEY}
      // и просили export — но без экспортированной переменной провайдер не поднимался.
      // Это изолированный конфиг Kilo, общие OPENAI_*/ANTHROPIC_* не трогаются.
      'Your API key was written into the config (file mode 0o600, owner-only) — no',
      'environment variable needed. Just restart Kilo to pick up the provider.',
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
