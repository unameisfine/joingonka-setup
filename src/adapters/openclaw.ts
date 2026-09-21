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
 *   agents.defaults.model.primary = "gonka/MiniMaxAI/MiniMax-M2.7" (только если не задан)
 *   agents.defaults.models[<ref>] = { alias } для моделей каталога
 *
 * Ключ: пишем РЕАЛЬНЫЙ jg-... литералом прямо в конфиг (файл 0o600, owner-only) —
 *   как нативный auth.json у opencode. Раньше писали ${GONKA_API_KEY}-ссылку и
 *   просили `export`, но gateway OpenClaw падал «SecretRef unresolved», если
 *   переменная не была в его окружении (а установщик её не персистил). Литерал
 *   работает без env. Изолированный конфиг OpenClaw — общие глобальные OPENAI_ /
 *   ANTHROPIC_ переменные не трогаются (та же причина, по которой НЕ пишем env).
 *
 * ★ Правки ТОЧЕЧНЫЕ (core/json-config): меняем только свои пути, а чужие
 * провайдеры, поля, алиасы, КОММЕНТАРИИ и форматирование файла остаются как
 * были. До 0.4.5 конфиг пересобирался через JSON.parse + сериализацию: файл с
 * комментарием или висячей запятой (openclaw.json — JSON5) не парсился, адаптер
 * молча стартовал с `{}` и уносил всю конфигурацию пользователя. Теперь такой
 * файл приводит к отказу без записи.
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
  OPENCLAW_DEFAULT_FALLBACKS,
  openclawModelEntry,
  openclawModelRef,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
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
 * Собирает список точечных правок по существующему конфигу.
 *
 * Что меняем: блок провайдера gonka (каталог моделей — целиком актуальным
 * набором, поэтому устаревшие модели прошлых версий исчезают), свои алиасы,
 * primary и запасные модели. Всё остальное в файле не адресуется ни одной
 * правкой и потому физически не может измениться.
 */
function buildEdits(
  existing: JsonObject,
  input: ApplyInput,
): { edits: JsonEdit[]; primaryRef: string } {
  const edits: JsonEdit[] = [];

  // 1. Провайдер gonka. Каталог моделей строим FRESH из актуального набора:
  //    массив заменяется целиком, поэтому устаревшие модели прошлых версий
  //    установщика (напр. Qwen) исчезают, а дубли не появляются.
  const models = OPENCLAW_MODELS.map((spec) => ({ id: spec.id, ...openclawModelEntry(spec) }));
  const provider = ['models', 'providers', OPENCLAW_PROVIDER_ID];
  edits.push(
    // mode:"merge" — слить наш каталог провайдеров с бандл-провайдерами OpenClaw.
    { path: ['models', 'mode'], value: 'merge' },
    { path: [...provider, 'baseUrl'], value: BASE_URL_OPENAI },
    { path: [...provider, 'api'], value: OPENCLAW_PROVIDER_API },
    // apiKey = ЛИТЕРАЛЬНЫЙ ключ jg-... (НЕ ${env}-ссылка): без ${...} OpenClaw
    // берёт значение как есть → работает БЕЗ внешней env-переменной.
    { path: [...provider, 'apiKey'], value: input.apiKey },
    { path: [...provider, 'models'], value: models },
  );

  // 2. Алиасы каталога: наши актуальные — ставим, наши устаревшие — удаляем.
  //    Чужие алиасы (openai/… и т.п.) не трогаем вовсе.
  const defaults = asObject(asObject(existing.agents)?.defaults) ?? {};
  for (const spec of OPENCLAW_MODELS) {
    if (!spec.aliasFor) continue;
    edits.push({
      path: ['agents', 'defaults', 'models', openclawModelRef(spec.id), 'alias'],
      value: spec.aliasFor,
    });
  }
  const aliasMap = asObject(defaults.models);
  if (aliasMap) {
    for (const ref of Object.keys(aliasMap)) {
      if (isStaleProviderModelRef(ref, OPENCLAW_PROVIDER_ID, CANONICAL_IDS)) {
        edits.push({ path: ['agents', 'defaults', 'models', ref], value: undefined });
      }
    }
  }

  // 3. primary: явный --model пишем всегда (иначе флаг молча не действует),
  //    иначе — только если primary пуст или указывает на нашу убранную модель.
  const modelBlock = asObject(defaults.model) ?? {};
  const primary = modelBlock.primary;
  const primaryNeedsReset =
    typeof primary !== 'string' ||
    primary.trim() === '' ||
    isStaleProviderModelRef(primary, OPENCLAW_PROVIDER_ID, CANONICAL_IDS);
  // primaryRef — то, что в конфиге окажется ФАКТИЧЕСКИ (для сообщения пользователю:
  // печатать «Default model: …наш дефолт», сохранив чужой primary, — враньё).
  let primaryRef: string;
  if (input.modelExplicit) {
    primaryRef = openclawModelRef(input.model);
    edits.push({ path: ['agents', 'defaults', 'model', 'primary'], value: primaryRef });
  } else if (primaryNeedsReset) {
    primaryRef = OPENCLAW_DEFAULT_PRIMARY;
    edits.push({ path: ['agents', 'defaults', 'model', 'primary'], value: primaryRef });
  } else {
    primaryRef = primary as string;
  }

  // 4. Запасные модели: ёмкость DeepSeek и GLM ниже, чем у MiniMax, поэтому
  //    отказ основной модели должен переключать агента, а не ронять его.
  //    Свой список пользователя не трогаем.
  const fallbacks = modelBlock.fallbacks;
  const hasOwnFallbacks = Array.isArray(fallbacks) && fallbacks.length > 0;
  if (!hasOwnFallbacks) {
    edits.push({
      path: ['agents', 'defaults', 'model', 'fallbacks'],
      value: OPENCLAW_DEFAULT_FALLBACKS.filter((ref) => ref !== primaryRef),
    });
  }

  return { edits, primaryRef };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем ДО бэкапа: файл, который нельзя разобрать, приводит к отказу, и
  // тогда мы не трогаем диск вовсе (ни записи, ни лишнего .bak).
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const backupPath = backup(configPath);

  const { edits, primaryRef } = buildEdits(doc.value, input);
  const text = applyJsonEdits(doc.text, edits);

  // Записываем 0o600 (owner-only): в файле лежит литеральный ключ jg-..., как
  // нативный auth.json у opencode.
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${primaryRef}`,
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
