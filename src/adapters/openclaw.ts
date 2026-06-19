/**
 * Адаптер OpenClaw — JSON-конфиг ~/.openclaw/openclaw.json.
 *
 * Реальный OpenClaw хранит конфигурацию в JSON с вложенной структурой:
 *   models.providers.<id>  — каталог провайдеров (baseUrl/api/apiKey/models[])
 *   agents.defaults        — primary-модель и алиасы (agents.defaults.models)
 *
 * Что прописываем (провайдер `gonka`, OpenAI-режим через /v1/chat/completions):
 *   models.providers.gonka = {
 *     baseUrl: BASE_URL_OPENAI (С /v1 — OpenAI-совместимый клиент),
 *     api: "openai-completions",
 *     apiKey: "GONKA_API_KEY"   // ← ИМЯ env-переменной, НЕ сам секрет
 *     models: [ 6 записей: 3 базовых + 3 :online ]
 *   }
 *   (поле `auth` НЕ пишем — как GonkaGate в OpenAI-режиме)
 *   agents.defaults.model.primary = "gonka/moonshotai/Kimi-K2.6" (только если не задан)
 *   agents.defaults.models[<ref>] = { alias } для трёх базовых моделей
 *
 * ⚠️ Безопасность: реальный ключ jg-... в файл НЕ пишется. В конфиг идёт лишь
 *   ИМЯ переменной окружения (GONKA_API_KEY), а пользователю возвращается
 *   инструкция `export GONKA_API_KEY=jg-...`. Так секрет не оседает на диске
 *   в общедоступном (для процессов пользователя) JSON.
 *
 * Слияние НЕ разрушает чужие данные: другие провайдеры, чужие поля внутри
 * нашего провайдера, чужие алиасы и пользовательский primary сохраняются
 * (deepMergeJson + upsertById, primary ставится только при отсутствии).
 *
 * Путь один для обоих scope: OpenClaw читает глобальный конфиг. Env
 * OPENCLAW_CONFIG_PATH (если задан) переопределяет путь.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  BASE_URL_OPENAI,
  OPENCLAW_PROVIDER_ID,
  OPENCLAW_PROVIDER_API,
  OPENCLAW_API_KEY_ENV,
  OPENCLAW_MODELS,
  OPENCLAW_DEFAULT_PRIMARY,
  openclawModelEntry,
  openclawModelRef,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { deepMergeJson, upsertById, type JsonObject } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/**
 * Разрешение пути:
 *   1. env OPENCLAW_CONFIG_PATH (trim, непустой) — приоритет;
 *   2. иначе ~/.openclaw/openclaw.json.
 * homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env).
 */
function resolvePath(_scope: Scope): string {
  const fromEnv = process.env.OPENCLAW_CONFIG_PATH;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return join(homedir(), '.openclaw', 'openclaw.json');
}

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Строит итоговый конфиг из существующего объекта, не разрушая чужие данные.
 *
 * Шаги:
 *   - upsert наших 6 моделей в существующий models[] провайдера gonka по id;
 *   - deep-merge провайдера gonka (baseUrl/api/apiKey + смерженный models);
 *   - deep-merge алиасов в agents.defaults.models;
 *   - primary в agents.defaults.model.primary — ТОЛЬКО если ещё не задан.
 */
function buildConfig(existing: JsonObject): JsonObject {
  // 1. Каталог моделей: стартуем с существующего массива провайдера (если есть)
  //    и upsert-им наши записи по id — повторный apply не плодит дубли.
  const existingProvider = asObject(
    asObject(asObject(existing.models)?.providers)?.[OPENCLAW_PROVIDER_ID],
  );
  const existingModels = Array.isArray(existingProvider?.models)
    ? (existingProvider!.models as unknown[])
    : [];
  let models: unknown[] = existingModels;
  for (const spec of OPENCLAW_MODELS) {
    models = upsertById(models, { id: spec.id, ...openclawModelEntry(spec) });
  }

  // 2. Патч провайдера + агентов (deep-merge сохранит чужие провайдеры/алиасы).
  const patch: JsonObject = {
    models: {
      providers: {
        [OPENCLAW_PROVIDER_ID]: {
          baseUrl: BASE_URL_OPENAI,
          api: OPENCLAW_PROVIDER_API,
          // apiKey = ИМЯ env-переменной (НЕ секрет): см. шапку файла.
          // Поле `auth` намеренно не пишем (OpenAI-режим, как GonkaGate).
          apiKey: OPENCLAW_API_KEY_ENV,
          models,
        },
      },
    },
    agents: {
      defaults: {
        models: Object.fromEntries(
          OPENCLAW_MODELS.filter((m) => m.aliasFor).map((m) => [
            openclawModelRef(m.id),
            { alias: m.aliasFor },
          ]),
        ),
      },
    },
  };

  const merged = deepMergeJson(existing, patch);

  // 3. primary — только если пользователь ещё не задал свой.
  const defaults = asObject(asObject(merged.agents)?.defaults) ?? {};
  const modelBlock = asObject(defaults.model) ?? {};
  if (typeof modelBlock.primary !== 'string' || modelBlock.primary.trim() === '') {
    const agents = asObject(merged.agents) ?? {};
    merged.agents = {
      ...agents,
      defaults: {
        ...defaults,
        model: { ...modelBlock, primary: OPENCLAW_DEFAULT_PRIMARY },
      },
    };
  }

  return merged;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем существующее (если есть) и бэкапим ВСЕГДА при наличии файла —
  // даже если JSON битый, чтобы пользователь не потерял данные безвозвратно.
  const raw = readRaw(configPath);
  const backupPath = backup(configPath);

  let existing: JsonObject = {};
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      existing = asObject(parsed) ?? {};
    } catch {
      // Битый JSON → стартуем со свежего объекта (бэкап уже сделан).
      existing = {};
    }
  }

  const config = buildConfig(existing);

  // Записываем с правами 0o600 (в файле — имена env, но конфиг приватный).
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n', OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${OPENCLAW_DEFAULT_PRIMARY}`,
      '',
      'Your API key is read from an environment variable (not stored in the config).',
      `Set it in your shell, then restart OpenClaw:`,
      `  export ${OPENCLAW_API_KEY_ENV}=${input.apiKey}`,
      `To persist it, add that line to your ~/.bashrc or ~/.zshrc.`,
    ],
  };
}

export const openclawAdapter: Adapter = {
  id: 'openclaw',
  label: 'OpenClaw (OpenAI-compatible)',
  format: 'json',
  resolvePath,
  apply,
};
