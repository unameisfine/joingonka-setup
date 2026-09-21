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
 * Дефолтная модель живёт в ДРУГОМ файле — settings.json рядом с models.json
 * (`defaultProvider` + `defaultModel`). Пишем его только если дефолт не задан,
 * указывает на нашу убранную модель ИЛИ пользователь задал `--model` явно:
 * чужой выбор не трогаем.
 *
 * ★ Правки ТОЧЕЧНЫЕ (core/json-config) в обоих файлах: чужие провайдеры, чужие
 * поля внутри нашего блока, комментарии и форматирование остаются как были.
 * Каталог моделей нашего провайдера при этом заменяется целиком — устаревшие
 * модели прошлых версий установщика (напр. Qwen) исчезают при повторном запуске.
 *
 * ★ Файл, который нельзя разобрать, — ОТКАЗ без записи и без бэкапа, причём оба
 * файла читаются ДО первой записи. До 0.4.5 битый models.json заменялся свежим
 * (пропадали провайдеры и ключи всех остальных сервисов пользователя), а битый
 * settings.json обнаруживался уже после записи models.json — установка
 * проходила наполовину.
 *
 * Путь один для обоих scope (Pi читает глобальный каталог) — см. piAgentDir.
 */
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  PI_PROVIDER_ID,
  PI_PROVIDER_API,
  piModelEntry,
} from '../constants.js';
import { catalogFor, catalogIds } from '../core/catalog.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { asObject, entriesById } from '../core/json-shape.js';
import type { JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  expandTilde,
  pathApi,
  type PathContext,
} from '../core/paths.js';
import { priceFor } from '../core/pricing.js';
import { staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/**
 * Каталог агента Pi — там лежат models.json и settings.json.
 *
 * Сверено 21.09.2026 по исходнику Pi (github.com/earendil-works/pi,
 * packages/coding-agent/src/config.ts — getAgentDir, ENV_AGENT_DIR; npm-пакет
 * теперь `@earendil-works/pi-coding-agent`):
 *   1. PI_CODING_AGENT_DIR — САМ каталог агента (замена ~/.pi/agent целиком,
 *      «agent» к нему не дописывается); ведущая тильда раскрывается;
 *   2. иначе ~/.pi/agent.
 *
 * До 0.4.5 адаптер читал переменную PI_HOME, которой у Pi никогда не было:
 * человек с настроенным PI_CODING_AGENT_DIR получал конфиг в каталоге, куда Pi
 * не смотрит, — и «успешную» установку.
 *
 * Окружение приходит параметром, чтобы чужую платформу можно было проверить тестом.
 */
export function piAgentDir(ctx: PathContext = currentPathContext()): string {
  const fromEnv = envValue(ctx, 'PI_CODING_AGENT_DIR');
  if (fromEnv) {
    return expandTilde(fromEnv, ctx);
  }
  return pathApi(ctx).join(ctx.home, '.pi', 'agent');
}

/** Путь к файлу внутри каталога агента; окружение читается В МОМЕНТ ВЫЗОВА. */
function agentFile(name: string): string {
  const ctx = currentPathContext();
  return pathApi(ctx).join(piAgentDir(ctx), name);
}

/** Основной конфиг адаптера — каталог провайдеров. */
function resolvePath(_scope: Scope): string {
  return agentFile('models.json');
}

/**
 * Правки models.json: наш блок провайдера. Каталог моделей — целиком актуальным
 * набором. Цена — живая на момент установки (input.pricing); нет живой — та, что
 * уже записана у этой модели; константа-фолбэк — только новой записи
 * (constants.ts, modelCost).
 */
function buildModelsEdits(existing: JsonObject, input: ApplyInput): JsonEdit[] {
  const provider = ['providers', PI_PROVIDER_ID];
  const recordedModels = entriesById(
    asObject(asObject(existing.providers)?.[PI_PROVIDER_ID])?.models,
  );
  // Явно запрошенная модель вне каталога тоже попадает в него (core/catalog.ts):
  // defaultModel, которого нет в models.json, Pi не находит.
  const models = catalogFor(input).map((spec) =>
    piModelEntry(spec, priceFor(input.pricing, spec.id), recordedModels.get(spec.id)?.cost),
  );
  return [
    { path: [...provider, 'baseUrl'], value: BASE_URL_OPENAI },
    { path: [...provider, 'api'], value: PI_PROVIDER_API },
    { path: [...provider, 'apiKey'], value: input.apiKey },
    { path: [...provider, 'models'], value: models },
  ];
}

/**
 * Решение по дефолтной модели в settings.json: при явном `--model` — пишем
 * всегда, иначе только когда дефолта нет ИЛИ он указывает на нашу модель,
 * которой больше нет в каталоге.
 *
 * ★ Раньше рабочий выбор пользователя (наш провайдер + актуальная модель)
 * молча перезаписывался на дефолт при каждой повторной установке, хотя гайд
 * обещал обратное.
 */
function planDefaultModel(
  settings: JsonObject,
  input: ApplyInput,
  settingsFile: string,
): { edits: JsonEdit[]; messages: string[]; staleRefs: number } {
  const currentProvider = settings.defaultProvider;
  const currentModel = settings.defaultModel;
  const isOurs = currentProvider === PI_PROVIDER_ID;
  // Живые — модели каталога ЭТОЙ установки: сеть плюс явно запрошенная вне каталога.
  const isStale =
    isOurs && typeof currentModel === 'string' && !catalogIds(input).includes(currentModel);
  const unset = typeof currentProvider !== 'string' || currentProvider.trim() === '';

  if (!input.modelExplicit && !unset && !isStale) {
    if (isOurs && typeof currentModel === 'string') {
      // Наш провайдер и актуальная модель — это осознанный выбор пользователя.
      return {
        edits: [],
        staleRefs: 0,
        messages: [
          `Kept your current default model (${currentModel}).`,
          `      Switch it with: --model deepseek|glm|minimax, or inside Pi: /model`,
        ],
      };
    }
    if (!isOurs) {
      // Пользователь выбрал ЧУЖОГО провайдера — не переключаем молча.
      return {
        edits: [],
        staleRefs: 0,
        messages: [
          `Kept your existing default model (${String(currentProvider)}/${String(currentModel)}).`,
          `      Switch inside Pi with: /model`,
        ],
      };
    }
  }

  return {
    edits: [
      { path: ['defaultProvider'], value: PI_PROVIDER_ID },
      { path: ['defaultModel'], value: input.model },
    ],
    staleRefs: isStale ? 1 : 0,
    messages: [`Default model set in ${settingsFile}`],
  };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);
  const settingsFile = agentFile('settings.json');

  // ★ Порядок: прочитать ОБА файла → посчитать ОБА итоговых текста → и только
  //   потом бэкапы и записи. Отказать может чтение (файл не разбирается) и
  //   расчёт правок (`"providers": [...]` вместо объекта) — в обоих случаях диск
  //   не тронут вовсе: ни записи, ни лишнего .bak.
  const modelsDoc = readJsonConfig(readRaw(configPath), configPath);
  const settingsDoc = readJsonConfig(readRaw(settingsFile), settingsFile);
  const plan = planDefaultModel(settingsDoc.value, input, settingsFile);

  const modelsText = applyJsonEdits(
    modelsDoc.text,
    buildModelsEdits(modelsDoc.value, input),
    configPath,
  );
  // settings.json трогаем, только когда есть что менять.
  const settingsText =
    plan.edits.length > 0 ? applyJsonEdits(settingsDoc.text, plan.edits, settingsFile) : null;

  // 0o600: внутри литеральный ключ jg-...
  const backupPath = backup(configPath);
  await atomicWrite(configPath, modelsText, OWNER_ONLY_MODE);

  // В settings.json секретов нет, поэтому права не форсим.
  if (settingsText !== null) {
    backup(settingsFile);
    await atomicWrite(settingsFile, settingsText);
  }

  const staleNote = staleRefsNote(plan.staleRefs);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Model: ${input.model}`,
      ...plan.messages,
      ...(staleNote ? [staleNote] : []),
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
  // Кодовый агент: решение оператора 21.09.2026 — там, где установщик ПИШЕТ
  // модель в конфиг, по умолчанию идёт DeepSeek V4 Flash (380K/32768).
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  // В каталоге моделей есть `cost` — просим у оркестратора живые цены.
  wantsPricing: true,
  resolvePath,
  apply,
};
