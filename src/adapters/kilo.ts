/**
 * Адаптер Kilo Code (https://kilo.ai) — JSONC-конфиг ~/.config/kilo/kilo.jsonc.
 *
 * Новая (OpenCode-based) архитектура Kilo использует тот же формат кастомного
 * провайдера, что opencode (`@ai-sdk/openai-compatible`):
 *   provider.joingonka = { npm, name, options:{baseURL, apiKey:"<литеральный jg-...>"},
 *                          models:{ "<id>":{ name, tool_call, [reasoning], limit } } }
 *   model (top-level) = "joingonka/MiniMaxAI/MiniMax-M2.7" — только если не задан.
 *
 * Отличия от opencode: $schema = app.kilo.ai; модели несут `tool_call:true`
 * (Kilo требует нативный tool-calling) и `reasoning:true` для reasoning-моделей.
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
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
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

/**
 * Точечные правки kilo.jsonc: блок нашего провайдера (каталог моделей — целиком
 * актуальным набором) и top-level `model`. Файл — JSONC: комментарии и висячие
 * запятые в нём законны, поэтому правим текст, а не пересобираем документ.
 */
function buildEdits(existing: JsonObject, input: ApplyInput): { edits: JsonEdit[]; model: string } {
  const provider = ['provider', KILO_PROVIDER_ID];
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://app.kilo.ai/config.json' },
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka' },
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    // Литеральный ключ jg-... (НЕ {env:...}-ссылка): без env-формы Kilo берёт
    // значение как есть → работает БЕЗ внешней переменной. Файл 0o600.
    { path: [...provider, 'options', 'apiKey'], value: input.apiKey },
    { path: [...provider, 'models'], value: buildModels() },
  ];

  const current = existing.model;
  const needsReset =
    typeof current !== 'string' ||
    current.trim() === '' ||
    isStaleProviderModelRef(current, KILO_PROVIDER_ID, CANONICAL_IDS);

  let model: string;
  if (input.modelExplicit) {
    model = `${KILO_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (needsReset) {
    model = KILO_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current as string;
  }

  return { edits, model };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем ДО бэкапа: неразбираемый конфиг = отказ без единой записи на диск.
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const backupPath = backup(configPath);

  const { edits, model } = buildEdits(doc.value, input);
  await atomicWrite(configPath, applyJsonEdits(doc.text, edits), OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${model}`,
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
