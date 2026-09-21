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
 *   agents.defaults.model.primary = OPENCLAW_DEFAULT_PRIMARY (только если не задан
 *     или указывает на нашу убранную модель) + fallbacks — запасные модели
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
import type { JSONPath } from 'jsonc-parser';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
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
import { priceFor } from '../core/pricing.js';
import { staleRefsNote } from '../core/stale-refs.js';
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

/** true — ссылка на НАШ провайдер, а модели в каталоге уже нет. */
function isStale(ref: unknown): boolean {
  return isStaleProviderModelRef(ref, OPENCLAW_PROVIDER_ID, CANONICAL_IDS);
}

/**
 * Правки поля `model` одного агента: строка "provider/model" либо объект
 * { primary, fallbacks } — те же две формы, что у agents.defaults.model.
 * Наша убранная модель в primary заменяется на `primaryRef`, из запасных —
 * выбрасывается. Чужие ссылки не трогаем.
 */
function agentModelEdits(
  path: JSONPath,
  model: unknown,
  primaryRef: string,
): { edits: JsonEdit[]; staleRefs: number } {
  if (typeof model === 'string') {
    return isStale(model)
      ? { edits: [{ path, value: primaryRef }], staleRefs: 1 }
      : { edits: [], staleRefs: 0 };
  }

  const block = asObject(model);
  if (!block) return { edits: [], staleRefs: 0 };

  const edits: JsonEdit[] = [];
  let staleRefs = 0;
  if (isStale(block.primary)) {
    edits.push({ path: [...path, 'primary'], value: primaryRef });
    staleRefs += 1;
  }
  if (Array.isArray(block.fallbacks)) {
    const live = block.fallbacks.filter((ref) => !isStale(ref));
    if (live.length !== block.fallbacks.length) {
      // Массив — целиком (см. пояснение про jsonc-parser в buildEdits).
      edits.push({ path: [...path, 'fallbacks'], value: live });
      staleRefs += block.fallbacks.length - live.length;
    }
  }
  return { edits, staleRefs };
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
): { edits: JsonEdit[]; primaryRef: string; staleRefs: number } {
  const edits: JsonEdit[] = [];
  // Сколько ссылок на убранные модели вычищено — для сообщения пользователю.
  let staleRefs = 0;

  // 1. Провайдер gonka. Каталог моделей строим FRESH из актуального набора:
  //    массив заменяется целиком, поэтому устаревшие модели прошлых версий
  //    установщика (напр. Qwen) исчезают, а дубли не появляются.
  //    Цена — живая на момент установки (input.pricing), иначе константа-фолбэк.
  const models = OPENCLAW_MODELS.map((spec) => ({
    id: spec.id,
    ...openclawModelEntry(spec, priceFor(input.pricing, spec.id)),
  }));
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
      if (isStale(ref)) {
        edits.push({ path: ['agents', 'defaults', 'models', ref], value: undefined });
        staleRefs += 1;
      }
    }
  }

  // 3. primary и запасные модели. По доке OpenClaw `agents.defaults.model` —
  //    строка "provider/model" ЛИБО объект { primary, fallbacks }
  //    (docs/gateway/config-agents/models.md, сверено 21.09.2026).
  //    Явный --model пишем всегда (иначе флаг молча не действует), без него —
  //    только если primary пуст или указывает на нашу убранную модель.
  const rawModel = defaults.model;
  const modelBlock = asObject(rawModel) ?? {};
  const primary = typeof rawModel === 'string' ? rawModel : modelBlock.primary;
  const primaryIsStale = isStale(primary);
  const primaryNeedsReset =
    typeof primary !== 'string' || primary.trim() === '' || primaryIsStale;
  if (primaryIsStale) staleRefs += 1;

  // primaryRef — то, что в конфиге окажется ФАКТИЧЕСКИ (для сообщения пользователю:
  // печатать «Default model: …наш дефолт», сохранив чужой primary, — враньё).
  const writePrimary = input.modelExplicit === true || primaryNeedsReset;
  let primaryRef: string;
  if (input.modelExplicit) {
    primaryRef = openclawModelRef(input.model);
  } else if (primaryNeedsReset) {
    primaryRef = OPENCLAW_DEFAULT_PRIMARY;
  } else {
    primaryRef = primary as string;
  }

  //    Запасные: ёмкость DeepSeek и GLM ниже, чем у MiniMax, поэтому отказ
  //    основной модели должен переключать агента, а не ронять его. Свой список
  //    пользователя не трогаем — кроме НАШИХ убранных моделей в нём; если после
  //    чистки список пуст (в нём были только они), ставим наш.
  const userFallbacks = Array.isArray(modelBlock.fallbacks) ? modelBlock.fallbacks : [];
  const liveFallbacks = userFallbacks.filter((ref) => !isStale(ref));
  const staleFallbacks = userFallbacks.length - liveFallbacks.length;
  staleRefs += staleFallbacks;
  const fallbacks =
    liveFallbacks.length > 0
      ? liveFallbacks
      : OPENCLAW_DEFAULT_FALLBACKS.filter((ref) => ref !== primaryRef);

  const modelPath = ['agents', 'defaults', 'model'];
  if (rawModel === undefined || asObject(rawModel)) {
    if (writePrimary) edits.push({ path: [...modelPath, 'primary'], value: primaryRef });
    // Массив заменяем ЦЕЛИКОМ, а не удаляем элементы по индексу: jsonc-parser
    // 3.3.1 портит однострочный массив при удалении последнего элемента.
    if (liveFallbacks.length === 0 || staleFallbacks > 0) {
      edits.push({ path: [...modelPath, 'fallbacks'], value: fallbacks });
    }
  } else if (writePrimary) {
    // Строка (или мусор на её месте): поле внутрь неё не вставить — до 0.4.5
    // установка здесь падала с «Can not add index to parent of type string».
    // Меняем значение целиком. Чужую строку без --model не трогаем вовсе:
    // строка означает «только primary, без запасных», и это выбор пользователя.
    edits.push({ path: modelPath, value: { primary: primaryRef, fallbacks } });
  }

  // 4. Модели отдельных агентов. Агент, закреплённый за нашей убранной
  //    моделью, получает ФАКТИЧЕСКИЙ primary (а не наш дефолт: если основной у
  //    человека чужой, молча пересаживать его агентов на нас нельзя).
  //    Формы: `agents.entries.<id>` — текущая, `agents.list[]` — прежняя, её
  //    переносит `openclaw doctor --fix` (docs/gateway/config-agents/
  //    entries-and-multi-agent.md, docs/gateway/doctor/config-migrations.md).
  const agents = asObject(existing.agents);
  const collect = (path: JSONPath, agent: unknown) => {
    const found = agentModelEdits(path, asObject(agent)?.model, primaryRef);
    edits.push(...found.edits);
    staleRefs += found.staleRefs;
  };
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((agent, index) => collect(['agents', 'list', index, 'model'], agent));
  }
  for (const [id, agent] of Object.entries(asObject(agents?.entries) ?? {})) {
    collect(['agents', 'entries', id, 'model'], agent);
  }

  return { edits, primaryRef, staleRefs };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Порядок: прочитать → посчитать итоговый текст → и только потом бэкап и
  // запись. Отказать может и чтение (файл не разбирается), и расчёт правок
  // (на пути правки примитив вместо объекта) — в обоих случаях диск не тронут
  // вовсе: ни записи, ни лишнего .bak при несостоявшейся установке.
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const { edits, primaryRef, staleRefs } = buildEdits(doc.value, input);
  const text = applyJsonEdits(doc.text, edits, configPath);
  const staleNote = staleRefsNote(staleRefs);

  const backupPath = backup(configPath);

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
      ...(staleNote ? [staleNote] : []),
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
  // ★ Тот же дефолт, что уходит в конфиг (OPENCLAW_DEFAULT_PRIMARY). Оркестратор
  // проверяет живым запросом модель из `defaultModel`; пока поля не было, без
  // `--model` в конфиг писался DeepSeek, а «Verified» выдавалось за MiniMax —
  // проверка подтверждала не ту модель, с которой инструмент пойдёт в сеть.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  // В каталоге моделей есть `cost` — просим у оркестратора живые цены.
  wantsPricing: true,
  resolvePath,
  apply,
};
