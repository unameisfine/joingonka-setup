/**
 * Адаптер Pi (https://pi.dev) — JSON ~/.pi/agent/models.json.
 *
 * Pi объявляет кастомные провайдеры декларативно:
 *   providers.<id> = { baseUrl, api, apiKey, models: [ {id, name, contextWindow,
 *                      maxTokens, input, cost, [reasoning]} ] }
 *
 * Что прописываем (провайдер `joingonka`, OpenAI-режим):
 *   baseUrl = BASE_URL_OPENAI (С /v1 — Pi дописывает /chat/completions);
 *   api     = "openai-completions";
 *   apiKey  = ЛИТЕРАЛЬНЫЙ jg-... (файл 0o600).
 *
 * Ключ ЛИТЕРАЛОМ, а НЕ `$GONKA_API_KEY`: Pi поддерживает три формы значения —
 * литерал, `$VAR`/`${VAR}` и `!command` — но env-ссылка требует, чтобы
 * переменная была в окружении процесса, а установщик её не персистит (ровно
 * те грабли, из-за которых env-ref убран у openclaw/kilo в 0.2.6).
 *
 * Дефолтная модель живёт в ДРУГОМ файле — ~/.pi/agent/settings.json
 * (`defaultProvider` + `defaultModel`). Пишем его только если он валиден или
 * отсутствует, и только если дефолт не задан ИЛИ указывает на нашу убранную
 * модель: чужой выбор пользователя не трогаем. Битый settings.json не
 * перезаписываем — провайдер работает и без него (в отличие от models.json,
 * без которого смысла нет).
 *
 * Каталог моделей нашего провайдера строим FRESH: устаревшие модели прошлых
 * версий установщика (напр. Qwen) исчезают при повторном запуске.
 *
 * Путь один для обоих scope (Pi читает глобальный каталог провайдеров).
 * Env PI_HOME (КАТАЛОГ) переопределяет ~/.pi.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  PI_PROVIDER_ID,
  PI_PROVIDER_API,
  piModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { deepMergeJson, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Каталог Pi: env PI_HOME (trim, непустой) либо ~/.pi. */
function piHome(): string {
  const fromEnv = process.env.PI_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return join(homedir(), '.pi');
}

/** Основной конфиг адаптера — каталог провайдеров. */
function resolvePath(_scope: Scope): string {
  return join(piHome(), 'agent', 'models.json');
}

/** Файл общих настроек Pi — там живёт выбор дефолтной модели. */
function settingsPath(): string {
  return join(piHome(), 'agent', 'settings.json');
}

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Парсит JSON-файл в объект; null → «файла нет», undefined → «битый». */
function readJsonObject(path: string): JsonObject | null | undefined {
  const raw = readRaw(path);
  if (raw == null) return null;
  try {
    return asObject(JSON.parse(raw)) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * Каталог провайдера: наш блок строится FRESH (модели заменяются целиком),
 * чужие провайдеры и чужие поля внутри нашего — сохраняются deep-merge'ем.
 */
function buildModelsConfig(existing: JsonObject, apiKey: string): JsonObject {
  const models = OPENCLAW_MODELS.map((spec) => piModelEntry(spec));

  const merged = deepMergeJson(existing, {
    providers: {
      [PI_PROVIDER_ID]: {
        baseUrl: BASE_URL_OPENAI,
        api: PI_PROVIDER_API,
        apiKey,
        models,
      },
    },
  });

  // deepMergeJson заменяет массив целиком, но подстрахуемся явно: наш каталог —
  // единственный источник правды по СВОИМ моделям.
  const ourProvider = asObject(asObject(merged.providers)?.[PI_PROVIDER_ID]);
  if (ourProvider) ourProvider.models = models;

  return merged;
}

/**
 * Ставит дефолтную модель в settings.json, если её нет ИЛИ она указывает на
 * нашего провайдера с моделью, которой больше нет в каталоге. Возвращает
 * сообщения для пользователя.
 */
async function applyDefaultModel(model: string): Promise<string[]> {
  const path = settingsPath();
  const existing = readJsonObject(path);

  if (existing === undefined) {
    // Битый JSON: НЕ трогаем (провайдер работает и без дефолта).
    return [
      `Note: ${path} is not valid JSON — left untouched.`,
      `      Pick the model in Pi with: /model`,
    ];
  }

  const base = existing ?? {};
  const currentProvider = base.defaultProvider;
  const currentModel = base.defaultModel;
  const isOurs = currentProvider === PI_PROVIDER_ID;
  const isStale = isOurs && typeof currentModel === 'string' && !CANONICAL_IDS.includes(currentModel);
  const unset = typeof currentProvider !== 'string' || String(currentProvider).trim() === '';

  if (!unset && !isStale && !isOurs) {
    // Пользователь выбрал ЧУЖОГО провайдера — не переключаем молча.
    return [
      `Kept your existing default model (${String(currentProvider)}/${String(currentModel)}).`,
      `      Switch inside Pi with: /model`,
    ];
  }

  backup(path);
  const next = { ...base, defaultProvider: PI_PROVIDER_ID, defaultModel: model };
  await atomicWrite(path, JSON.stringify(next, null, 2) + '\n');
  return [`Default model set in ${path}`];
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Бэкапим ВСЕГДА при наличии файла — даже если JSON битый.
  const existing = readJsonObject(configPath);
  const backupPath = backup(configPath);

  // Битый models.json → стартуем со свежего объекта (бэкап уже сделан).
  const base = existing === undefined || existing === null ? {} : existing;
  const config = buildModelsConfig(base, input.apiKey);

  // 0o600: внутри литеральный ключ jg-...
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n', OWNER_ONLY_MODE);

  const defaultMessages = await applyDefaultModel(input.model);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Model: ${input.model}`,
      ...defaultMessages,
      '',
      // Ключ записан ЛИТЕРАЛЬНО (0o600). Pi умеет и $VAR-ссылки, но они требуют
      // экспортированной переменной, которую установщик не персистит.
      'Your API key was written into the config (file mode 0o600, owner-only) — no',
      'environment variable needed. Pi reloads models.json every time you open /model.',
      'Run Pi in a sandbox: it executes shell commands without step-by-step approval.',
    ],
  };
}

export const piAdapter: Adapter = {
  id: 'pi',
  label: 'Pi (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
