/**
 * Общие константы установщика @joingonka/setup.
 *
 * Базовые URL и модели захардкожены и НЕ конфигурируются через CLI:
 * всё ценностное предложение пакета — одна команда, перенаправляющая
 * агентный инструмент на наш managed-gateway. Флаг перезаписи URL
 * обесценил бы пакет и увеличил риск ошибок.
 */

/**
 * Base URL для Anthropic-совместимых инструментов (Claude Code и т.п.).
 * БЕЗ суффикса /v1 — Claude Code сам добавляет /v1/messages.
 */
export const BASE_URL = 'https://gate.joingonka.ai';

/**
 * Base URL для OpenAI-совместимых инструментов (OpenClaw, Cline и т.п.).
 * С суффиксом /v1 — клиенты дописывают /chat/completions к нему.
 *
 * ВАЖНО: отличие /v1 vs без /v1 между двумя семействами инструментов —
 * частый источник ошибок конфигурации, поэтому константы разделены явно.
 */
export const BASE_URL_OPENAI = 'https://gate.joingonka.ai/v1';

/**
 * Модель по умолчанию — MiniMax-M2.7. Активна в сети (operational),
 * нативный tool calling, сильная на агентных задачах.
 */
export const DEFAULT_MODEL = 'MiniMaxAI/MiniMax-M2.7';

/**
 * GLM-5.3 Flash (Z.ai) — reasoning, контекст 390K (самый длинный в сети),
 * потолок ответа 8192. В сети Gonka с 16.09.2026. Выбирается `--model glm`.
 */
export const GLM_MODEL = 'zai-org/GLM-5.3-Flash';

/**
 * DeepSeek V4 Flash — контекст 380K и самый высокий в сети потолок ответа
 * (32768), reasoning + tool calling. Выбирается `--model deepseek`.
 */
export const DEEPSEEK_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731';

/**
 * Модель по умолчанию для инструментов, которым установщик ПИШЕТ модель в
 * конфиг (claude-code, codex, opencode, openclaw, hermes, pi, omp, kilo, goose,
 * crush, qwen-code, kimi-code, droid, mimo-code, minimax-code) — решение
 * оператора 21.09.2026: у кодовых агентов длинный контекст и потолок ответа
 * важнее, чем максимальная ёмкость сети.
 *
 * Инструменты, которым мы только ПЕЧАТАЕМ инструкцию (Cursor, Cline, Continue,
 * Aider, JetBrains, Copilot, ZCode, Zoo, Roo), остаются на DEFAULT_MODEL: там
 * модель выбирает человек руками, и подсказывать стоит самую ёмкую. Там же и Zed:
 * без `--model` он пишет провайдера и каталог, а модель выбирается в панели агента.
 *
 * ★ Каждый такой адаптер обязан объявить `defaultModel: CODING_AGENT_DEFAULT_MODEL`:
 * по этому полю оркестратор выбирает модель live-проверки, и без него «Verified»
 * подтверждает MiniMax, хотя в конфиг ушёл DeepSeek (так было у openclaw,
 * opencode и kilo до 0.5.0). Правило держит тест adapters/all-adapters.test.ts.
 *
 * ⚠ Ёмкость DeepSeek ниже, чем у MiniMax (замер 19.09.2026: худший час 56%
 * успешных против 98%). Поэтому там, где инструмент умеет запасные модели,
 * их обязательно прописываем (OpenClaw — OPENCLAW_DEFAULT_FALLBACKS).
 */
export const CODING_AGENT_DEFAULT_MODEL = DEEPSEEK_MODEL;

// ────────────────────────────────────────────────────────────────────────────
// OpenClaw-специфичные константы (JSON-конфиг ~/.openclaw/openclaw.json)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Идентификатор нашего провайдера внутри `models.providers` OpenClaw-конфига.
 * Под этим ключом адаптер upsert-ит блок провайдера, не трогая чужие
 * (`openai`, `anthropic` и т.п.).
 */
export const OPENCLAW_PROVIDER_ID = 'gonka';

/**
 * Транспорт провайдера для OpenClaw. Подключаемся в OpenAI-режиме через наш
 * зрелый роут /v1/chat/completions (как GonkaGate), поэтому
 * `openai-completions`. baseUrl при этом — С суффиксом /v1 (BASE_URL_OPENAI).
 *
 * Поле `auth` НЕ пишем: GonkaGate в OpenAI-режиме его не указывает (клиент
 * по умолчанию шлёт Bearer-ключ из apiKey-переменной).
 */
export const OPENCLAW_PROVIDER_API = 'openai-completions';

/**
 * Запись одной модели для каталога провайдера OpenClaw.
 *
 * id        — каноничный id модели (casing как в SSOT model-specs.ts,
 *             например `zai-org/GLM-5.3-Flash` — НЕ lowercase).
 * name      — человекочитаемое имя в UI выбора модели OpenClaw.
 * maxTokens — потолок выдачи (совпадает с max_output из SSOT).
 * aliasFor  — короткий alias в agents.defaults.models.
 */
export interface OpenClawModelSpec {
  id: string;
  name: string;
  maxTokens: number;
  aliasFor?: string;
  /**
   * Окно контекста модели: вход и ответ вместе. У моделей каталога задано всегда
   * (OPENCLAW_MODELS); нет его только у id вне каталога (core/catalog.ts) — тогда
   * адаптеры берут запасное OPENCLAW_CONTEXT_WINDOW.
   */
  contextWindow?: number;
  /** Модель отдаёт reasoning-контент (Kilo помечает `reasoning:true`). */
  reasoning?: boolean;
}

/** Модель каталога сети: окно у неё задано явно, своё (запасное — не для неё). */
type NetworkModelSpec = OpenClawModelSpec & { contextWindow: number };

/** Цена модели, $ за 1M токенов: вход и выход. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * ФОЛБЭК цены для каталогов OpenClaw, Pi, omp и Crush ($/1M токенов).
 *
 * Значения справочные — реальная тарификация считается на шлюзе, здесь они
 * нужны лишь чтобы инструмент показывал примерную стоимость в своём UI.
 *
 * Цена в GNK фиксирована (33/99 nGNK за токен), а в долларах плавает вместе с
 * курсом GNK, поэтому установщик берёт живые значения из публичного
 * GET /api/pricing (core/pricing.ts) и передаёт их в функции записи модели;
 * сюда они падают только при недоступности шлюза — и только для НОВОЙ записи
 * модели: уже записанную цену константа не затирает (см. modelCost).
 * Срез 19.09.2026: $0.0062 вход / $0.0185 выход за 1M.
 */
const FALLBACK_PRICE: ModelPrice = { input: 0.0062, output: 0.0185 };

/**
 * ОТМЕНЁННАЯ константа цены — она стояла в пакете с 0.1.0 по 0.4.4 и завышала
 * стоимость в UI инструмента в 5–11 раз (исправлено в 0.4.5). Нужна только для
 * того, чтобы отличить её в чужом конфиге от настоящей живой цены.
 */
const RETIRED_FALLBACK_PRICE: ModelPrice = { input: 0.07, output: 0.1 };

/**
 * true — пара чисел из конфига похожа на цену, которую стоит СОХРАНИТЬ, когда
 * живой цены в этом запуске нет: оба числа конечны и положительны, и это не
 * отменённая константа 0.07 / 0.1 (она живой ценой не была никогда — сохранить её
 * значило бы отменить исправление 0.4.5 всем, кто обновляется при недоступном шлюзе).
 */
export function isRecordedPrice(input: unknown, output: unknown): boolean {
  const priced = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!priced(input) || !priced(output)) return false;
  return !(input === RETIRED_FALLBACK_PRICE.input && output === RETIRED_FALLBACK_PRICE.output);
}

/**
 * Блок `cost` записи модели. Кеш-чтение и кеш-запись приравнены ко входу:
 * отдельного тарифа на кеш у шлюза нет.
 *
 * ★ Порядок источников (вторая часть 0.5.0):
 *   1. живая цена этого запуска (core/pricing.ts);
 *   2. цена, УЖЕ записанная у этой модели в конфиге, — возвращается как есть,
 *      вместе с полями, которые человек мог подправить руками;
 *   3. константа-фолбэк — только для новой записи (или мусора на месте цены).
 * Пока пункта 2 не было, повторный запуск при недоступном /api/pricing (таймаут
 * 3 с) менял живую цену прошлого запуска на более грубую константу: установка
 * переставала быть идемпотентной, а цена в UI инструмента — точной.
 */
function modelCost(price?: ModelPrice, recorded?: unknown): unknown {
  if (price === undefined && typeof recorded === 'object' && recorded !== null) {
    const { input, output } = recorded as { input?: unknown; output?: unknown };
    if (isRecordedPrice(input, output)) return recorded;
  }
  const { input, output } = price ?? FALLBACK_PRICE;
  return { input, output, cacheRead: input, cacheWrite: input };
}

/**
 * Каталог моделей сети Gonka — общий для всех адаптеров (исторически назван по
 * первому потребителю, OpenClaw).
 *
 * SSOT по id и лимитам — gateway/src/modules/network-status/model-specs.ts;
 * здесь РУЧНОЙ дубль, поэтому при каждом релизе сверять с живым
 * GET https://gate.joingonka.ai/v1/models (`context_length`,
 * `top_provider.max_completion_tokens`). Сверено 21.10.2026: состав, DeepSeek и
 * GLM совпадают; окно MiniMax исправлено на 180000 вместе с model-specs.ts шлюза.
 *
 * Потолок ответа у моделей РАЗНЫЙ: MiniMax и GLM — 8192, DeepSeek — 32768.
 * Кто из них primary у конкретного инструмента — решают CODING_AGENT_DEFAULT_MODEL
 * и DEFAULT_MODEL, а не порядок в этом списке.
 *
 * История состава одной строкой: Qwen3 (до 06.2026), Kimi K2.6 и GLM-5.2-FP8
 * (до 11.09.2026) выведены из сети; их id живут только в core/models.ts (RETIRED).
 *
 * Веб-поиск в OpenClaw — через его СОБСТВЕННЫЙ встроенный tools.web
 * (client-side); серверный web_search шлюза включается per-request, отдельные
 * модель-варианты для него не нужны.
 */
export const OPENCLAW_MODELS: readonly NetworkModelSpec[] = [
  // Окно 180000 — on-chain `--max-model-len` хостов: нода считает вход вместе с
  // max_tokens и сверх окна отвечает «maximum context length is 180000 tokens»
  // (сверено 21.10.2026). До 0.5.1 стояло 200000 по ошибочному замеру: вход
  // 200 011 токенов с HTTP 200 приняла Kimi, а у MiniMax тогда был таймаут
  // Cloudflare. Потолок ответа 8192 — замер: на 8192 ответ обрывается с
  // finish_reason:length. Самая ёмкая модель сети.
  {
    id: 'MiniMaxAI/MiniMax-M2.7',
    name: 'MiniMax M2.7 (Gonka)',
    maxTokens: 8192,
    aliasFor: 'minimax-m2.7',
    contextWindow: 180000,
  },
  // Окно 380000 — замер на проде 13.08.2026 (вход 381K токенов принят).
  // Потолок ответа 32768 — самый высокий в сети (замер 17.08.2026).
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    name: 'DeepSeek V4 Flash (Gonka)',
    maxTokens: 32768,
    aliasFor: 'deepseek-v4-flash',
    contextWindow: 380000,
    reasoning: true,
  },
  // GLM-5.3 Flash (Z.ai), в сети с 16.09.2026. Окно 390000 (самое длинное в
  // сети) и потолок ответа 8192 — ЗАМЕР 16.09.2026: on-chain --max-model-len
  // 400000 слепо не копируем, публикуем доказанный минимум.
  // Reasoning съедает несколько сотен токенов ответа: клиенту нужен max_tokens ≥ 600
  // либо stream, для коротких задач — reasoning_effort:'low'.
  {
    id: 'zai-org/GLM-5.3-Flash',
    name: 'GLM 5.3 Flash (Gonka)',
    maxTokens: 8192,
    aliasFor: 'glm-5.3-flash',
    contextWindow: 390000,
    reasoning: true,
  },
];

/**
 * Запасное окно контекста — для модели без своего значения, то есть для id вне
 * каталога (явный `--model` с моделью, которой установщик ещё не знает,
 * core/catalog.ts). Берётся НАИМЕНЬШЕЕ окно каталога: занизить безопаснее, чем
 * пообещать инструменту окно, которого у модели может не быть, — он перестанет
 * вовремя сжимать историю и получит отказ ноды. Это не «окно MiniMax» и не
 * «общее окно сети»: сейчас оно совпадает с MiniMax (180000) лишь потому, что её
 * окно в каталоге наименьшее. Имя историческое — по первому потребителю, OpenClaw.
 */
export const OPENCLAW_CONTEXT_WINDOW = Math.min(...OPENCLAW_MODELS.map((m) => m.contextWindow));

/**
 * Модель по умолчанию (primary) для OpenClaw в формате провайдер-ref
 * `<provider>/<modelId>`. Ставится в agents.defaults.model.primary ТОЛЬКО
 * если пользователь ещё не задал свой primary.
 */
export const OPENCLAW_DEFAULT_PRIMARY = `${OPENCLAW_PROVIDER_ID}/${CODING_AGENT_DEFAULT_MODEL}`;

/**
 * Запасные модели OpenClaw (`agents.defaults.model.fallbacks`) — по убыванию
 * ёмкости после primary: GLM, затем MiniMax. Решение оператора 21.09.2026.
 * Пишутся ТОЛЬКО если пользователь не задал свой список: смысл в том, чтобы
 * отказ модели с малой ёмкостью не превращался в отказ агента.
 */
export const OPENCLAW_DEFAULT_FALLBACKS: readonly string[] = [
  `${OPENCLAW_PROVIDER_ID}/${GLM_MODEL}`,
  `${OPENCLAW_PROVIDER_ID}/${DEFAULT_MODEL}`,
];

/**
 * Сборка JSON-записи модели для каталога провайдера OpenClaw.
 * Вынесено сюда, чтобы форма записи (cost/input/contextWindow) была SSOT
 * и не дублировалась в адаптере/тестах.
 *
 * @param price        живая цена модели (core/pricing.ts);
 * @param recordedCost блок `cost`, уже записанный у этой модели в конфиге, — он
 *                     остаётся как есть, когда живой цены нет (см. modelCost).
 */
export function openclawModelEntry(
  spec: OpenClawModelSpec,
  price?: ModelPrice,
  recordedCost?: unknown,
): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name,
    input: ['text'],
    contextWindow: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens,
    cost: modelCost(price, recordedCost),
  };
}

/**
 * Реальные лимиты модели — для печатных инструкций UI-адаптеров (Cline, Cursor,
 * JetBrains, ZCode, Continue, Aider, Roo): у этих инструментов окно и потолок
 * ответа вводит человек, и без подсказки он оставит дефолты инструмента
 * (64K у JetBrains, 128K у Cline), которые не совпадают ни с одной моделью сети.
 */
export interface ModelLimits {
  contextWindow: number;
  maxOutput: number;
  /** false — id вне каталога установщика, значения осторожные, а не измеренные. */
  known: boolean;
}

/**
 * Лимиты модели по id. Для id вне каталога — НАИМЕНЬШИЕ по каталогу окно
 * (OPENCLAW_CONTEXT_WINDOW) и потолок ответа: занизить безопаснее, чем пообещать
 * инструменту окно, которого у модели нет (он перестанет вовремя сжимать историю).
 */
export function modelLimits(modelId: string): ModelLimits {
  const spec = OPENCLAW_MODELS.find((m) => m.id === modelId);
  if (spec) {
    return {
      contextWindow: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
      maxOutput: spec.maxTokens,
      known: true,
    };
  }
  return {
    contextWindow: OPENCLAW_CONTEXT_WINDOW,
    maxOutput: Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens)),
    known: false,
  };
}

/** Строка с лимитами модели для инструментов, где вводить их некуда. */
export function formatModelLimits(modelId: string): string {
  const { contextWindow, maxOutput, known } = modelLimits(modelId);
  const line = `Model limits: context window ${contextWindow} tokens, max output ${maxOutput} tokens.`;
  return known
    ? line
    : `${line} (${modelId} is not in the installer catalog — conservative values; ` +
        `check ${BASE_URL_OPENAI}/models)`;
}

// --- opencode (https://opencode.ai) — opencode.json (провайдер) + auth.json (ключ, нативно) ---

/** Id нашего провайдера в opencode-конфиге (`provider.<id>`). */
export const OPENCODE_PROVIDER_ID = 'joingonka';

/**
 * npm-пакет AI SDK для OpenAI-совместимого endpoint на /v1/chat/completions.
 * opencode подтягивает его в рантайме сам (ручной npm install не нужен).
 */
export const OPENCODE_NPM = '@ai-sdk/openai-compatible';

/** Модель по умолчанию (top-level `model`): `<provider>/<modelId>` (= DEFAULT_MODEL). */
export const OPENCODE_DEFAULT_MODEL = `${OPENCODE_PROVIDER_ID}/${CODING_AGENT_DEFAULT_MODEL}`;

/**
 * Запись модели для opencode: `models: { "<id>": { name, limit:{context,output} } }`.
 * limit ОБЯЗАТЕЛЕН — без него opencode не знает остаток контекста (compaction off),
 * а output падает на дефолт. Берём из общего каталога Gonka (OPENCLAW_MODELS).
 */
export function opencodeModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  return {
    name: spec.name,
    limit: { context: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens },
  };
}

// --- Aider (https://aider.chat) — env-based, instructions-only ---

/**
 * Aider маршрутизирует модели через litellm: для OpenAI-совместимого endpoint
 * имя модели ОБЯЗАНО иметь префикс `openai/` (иначе litellm не поймёт провайдера —
 * массовая ошибка новичков). Полный id идёт после префикса.
 */
export const AIDER_MODEL_PREFIX = 'openai/';

/** Модель Aider по умолчанию (с обязательным префиксом). */
export const AIDER_DEFAULT_MODEL = `${AIDER_MODEL_PREFIX}${DEFAULT_MODEL}`;

// --- Kilo Code (https://kilo.ai) — JSONC ~/.config/kilo/kilo.jsonc (OpenCode-формат) ---

/** Id нашего провайдера в kilo.jsonc (`provider.<id>`). */
export const KILO_PROVIDER_ID = 'joingonka';

/** Модель по умолчанию (top-level `model`): `<provider>/<modelId>`. */
export const KILO_DEFAULT_MODEL = `${KILO_PROVIDER_ID}/${CODING_AGENT_DEFAULT_MODEL}`;

/**
 * Запись модели для Kilo: `{ name, tool_call, [reasoning], limit:{context,output} }`.
 * `tool_call:true` обязателен (Kilo требует нативный tool-calling); `reasoning:true`
 * для reasoning-моделей (DeepSeek, GLM). `limit` обязателен — иначе Kilo отключает
 * compaction (контекст растёт).
 */
export function kiloModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: spec.name,
    tool_call: true,
    limit: { context: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens },
  };
  if (spec.reasoning) entry.reasoning = true;
  return entry;
}

/**
 * Provider-ref модели (`<provider>/<modelId>`) для agents.defaults.models
 * и primary.
 */
export function openclawModelRef(modelId: string): string {
  return `${OPENCLAW_PROVIDER_ID}/${modelId}`;
}

// --- Pi (https://pi.dev) — JSON ~/.pi/agent/models.json + settings.json (дефолт) ---

/** Id нашего провайдера в `providers` файла models.json. */
export const PI_PROVIDER_ID = 'joingonka';

/**
 * Транспорт провайдера для Pi. Допустимые значения `api` (док pi, 08.2026):
 * openai-completions | openai-responses | anthropic-messages | google-generative-ai.
 * Наш зрелый роут — /v1/chat/completions, поэтому openai-completions
 * (baseUrl при этом С /v1 = BASE_URL_OPENAI).
 */
export const PI_PROVIDER_API = 'openai-completions';

/**
 * Запись модели для Pi: `{ id, name, input, contextWindow, maxTokens, cost, [reasoning] }`.
 * Схема совпадает с каталогом OpenClaw по смыслу полей, поэтому берём тот же
 * OpenClawModelSpec как SSOT. contextWindow/maxTokens задаём ЯВНО — дефолты Pi
 * (128000/16384) не совпадают с реальными лимитами сети. `cost` у Pi — тоже
 * $ за 1M токенов (док pi, docs/models.md: «Per-million-token rates»).
 *
 * @param price        живая цена модели (core/pricing.ts);
 * @param recordedCost блок `cost`, уже записанный у этой модели в конфиге, — он
 *                     остаётся как есть, когда живой цены нет (см. modelCost).
 */
export function piModelEntry(
  spec: OpenClawModelSpec,
  price?: ModelPrice,
  recordedCost?: unknown,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: spec.id,
    name: spec.name,
    input: ['text'],
    contextWindow: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens,
    cost: modelCost(price, recordedCost),
  };
  if (spec.reasoning) entry.reasoning = true;
  return entry;
}

// --- Zed (https://zed.dev) — JSONC ~/.config/zed/settings.json ---

/**
 * Id нашего провайдера в `language_models.openai_compatible` настроек Zed.
 * ВАЖНО: из него Zed выводит имя env-переменной для ключа — upper snake case
 * + `_API_KEY` (`joingonka` → `JOINGONKA_API_KEY`).
 */
export const ZED_PROVIDER_ID = 'joingonka';

/**
 * Имя env-переменной, откуда Zed берёт ключ нашего провайдера.
 * Ключ в settings.json класть НЕЛЬЗЯ — док Zed прямо запрещает
 * («Do not put API keys in settings.json»), он живёт в UI-хранилище или env.
 */
export const ZED_API_KEY_ENV = `${ZED_PROVIDER_ID.toUpperCase().replace(/-/g, '_')}_API_KEY`;

/**
 * Запись модели для Zed: `{ name, display_name, max_tokens, max_output_tokens,
 * capabilities }`.
 *
 * ⚠️ Гоча схемы Zed: `max_tokens` — это КОНТЕКСТНОЕ окно (не потолок выдачи),
 * а потолок выдачи — `max_output_tokens`. Перепутать = обрезанные ответы либо
 * переполнение контекста.
 */
export function zedModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  return {
    name: spec.id,
    display_name: spec.name,
    max_tokens: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    max_output_tokens: spec.maxTokens,
    // Все модели сети умеют нативный tool calling; картинок на вход нет.
    capabilities: { tools: true, images: false },
  };
}
