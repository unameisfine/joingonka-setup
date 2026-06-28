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
 *     apiKey: "<литеральный ключ jg-...>" // НЕ ${env}: без ${...} OpenClaw берёт как есть
 *     models: [ актуальные модели каталога Gonka ]
 *   }
 *   (поле `auth` НЕ пишем — как GonkaGate в OpenAI-режиме)
 *   agents.defaults.model.primary = "gonka/moonshotai/Kimi-K2.6" (только если не задан)
 *   agents.defaults.models[<ref>] = { alias } для моделей каталога
 *
 * Ключ: пишем РЕАЛЬНЫЙ jg-... литералом прямо в конфиг (файл 0o600, owner-only) —
 *   как нативный auth.json у opencode. Раньше писали ${GONKA_API_KEY}-ссылку и
 *   просили `export`, но gateway OpenClaw падал «SecretRef unresolved», если
 *   переменная не была в его окружении (а установщик её не персистил). Литерал
 *   работает без env. Изолированный конфиг OpenClaw — общие глобальные OPENAI_ /
 *   ANTHROPIC_ переменные не трогаются (та же причина, по которой НЕ пишем env).
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
  OPENCLAW_MODELS,
  OPENCLAW_DEFAULT_PRIMARY,
  openclawModelEntry,
  openclawModelRef,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import {
  deepMergeJson,
  isStaleProviderModelRef,
  pruneStaleProviderAliases,
  type JsonObject,
} from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для прунинга устаревших алиасов и сброса primary. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

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
 *   - каталог моделей провайдера gonka строим FRESH из актуального набора
 *     (deepMerge заменит массив → устаревшие модели, напр. Qwen, удаляются);
 *   - deep-merge провайдера gonka (baseUrl/api/apiKey + наш models);
 *   - deep-merge алиасов + прунинг НАШИХ устаревших алиасов в agents.defaults.models;
 *   - primary в agents.defaults.model.primary — ставим наш дефолт, если не задан
 *     ИЛИ указывает на нашу убранную модель (чужой/актуальный — не трогаем).
 */
function buildConfig(existing: JsonObject, apiKey: string): JsonObject {
  // 1. Каталог моделей нашего провайдера строим FRESH из актуального каталога —
  //    НЕ сидим из существующего. deepMergeJson заменяет массив целиком, поэтому
  //    устаревшие модели (напр. Qwen из прошлых версий установщика) удаляются, а
  //    дубли не появляются. Чужие провайдеры/поля сохранит deepMerge ниже.
  const models: unknown[] = OPENCLAW_MODELS.map((spec) => ({
    id: spec.id,
    ...openclawModelEntry(spec),
  }));

  // 2. Патч провайдера + агентов (deep-merge сохранит чужие провайдеры/алиасы).
  const patch: JsonObject = {
    models: {
      // mode:"merge" — слить наш каталог провайдеров с бандл-провайдерами OpenClaw,
      // а не заменить их (без него мульти-провайдерные сборки рискуют потерять бандлы).
      mode: 'merge',
      providers: {
        [OPENCLAW_PROVIDER_ID]: {
          baseUrl: BASE_URL_OPENAI,
          api: OPENCLAW_PROVIDER_API,
          // apiKey = ЛИТЕРАЛЬНЫЙ ключ jg-... (НЕ ${env}-ссылка). Без ${...} OpenClaw
          // берёт значение как есть → работает БЕЗ внешней env-переменной. Раньше
          // тут была ${GONKA_API_KEY}-ссылка: gateway падал «SecretRef unresolved»,
          // если переменная не экспортирована в его окружении (а установщик её не
          // персистил). Файл пишется 0o600 (owner-only), как нативный auth.json у
          // opencode. Поле `auth` не пишем (OpenAI-режим).
          apiKey,
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

  // 3. Алиасы agents.defaults.models: deepMerge добавил наши актуальные, но НЕ
  //    удалил бы НАШИ устаревшие (напр. gonka/Qwen…). Прунаем их; чужие алиасы
  //    (openai/… и т.п.) и актуальные наши — остаются.
  const defaults = asObject(asObject(merged.agents)?.defaults) ?? {};
  const aliasMap = asObject(defaults.models);
  const prunedAliases = aliasMap
    ? pruneStaleProviderAliases(aliasMap, OPENCLAW_PROVIDER_ID, CANONICAL_IDS)
    : undefined;

  // 4. primary — наш дефолт, если не задан ИЛИ указывает на нашу убранную модель
  //    (иначе OpenClaw сошлётся на несуществующую). Пользовательский primary на
  //    чужой провайдер или на актуальную нашу модель — НЕ трогаем.
  const modelBlock = asObject(defaults.model) ?? {};
  const primary = modelBlock.primary;
  const needPrimaryReset =
    typeof primary !== 'string' ||
    primary.trim() === '' ||
    isStaleProviderModelRef(primary, OPENCLAW_PROVIDER_ID, CANONICAL_IDS);

  // Пересобираем agents.defaults с прунутыми алиасами и (при необходимости) primary.
  const agents = asObject(merged.agents) ?? {};
  merged.agents = {
    ...agents,
    defaults: {
      ...defaults,
      ...(prunedAliases ? { models: prunedAliases } : {}),
      model: needPrimaryReset
        ? { ...modelBlock, primary: OPENCLAW_DEFAULT_PRIMARY }
        : modelBlock,
    },
  };

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

  const config = buildConfig(existing, input.apiKey);

  // Записываем 0o600 (owner-only): в файле лежит литеральный ключ jg-..., как
  // нативный auth.json у opencode.
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
      // Ключ записан ЛИТЕРАЛЬНО в конфиг (0o600). Никаких env-переменных: раньше мы
      // писали ${GONKA_API_KEY}-ссылку, и gateway OpenClaw падал, если переменная не
      // была экспортирована в его окружении. Это изолированный конфиг OpenClaw —
      // общие OPENAI_*/ANTHROPIC_* не затрагиваются.
      'Your API key was written into the config (file mode 0o600, owner-only) — no',
      'environment variable needed. Just restart OpenClaw to pick up the provider.',
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
