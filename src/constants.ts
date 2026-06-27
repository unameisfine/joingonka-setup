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
 * Альтернативная модель Kimi K2.6 — длинный контекст.
 * Выбирается через CLI `--model kimi`.
 */
export const KIMI_MODEL = 'moonshotai/Kimi-K2.6';

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
 * Имя env-переменной, ИЗ которой OpenClaw читает наш ключ во время работы.
 * Ключ jg-... не должен попадать в файл на диске — пользователю выдаётся
 * инструкция `export GONKA_API_KEY=jg-...`.
 */
export const OPENCLAW_API_KEY_ENV = 'GONKA_API_KEY';

/**
 * Что РЕАЛЬНО пишется в `apiKey` конфига — `${GONKA_API_KEY}`-ссылка, НЕ голое имя.
 * OpenClaw подставляет env только для формы `${VAR}`/`$VAR`/известных маркеров
 * (`models-config.providers.secrets.ts`); голое `GONKA_API_KEY` он бы отправил
 * ЛИТЕРАЛОМ в `Authorization: Bearer GONKA_API_KEY` → 401. Поэтому ровно `${...}`.
 */
export const OPENCLAW_API_KEY_REF = `\${${OPENCLAW_API_KEY_ENV}}`;

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
 *             например `moonshotai/Kimi-K2.6` — НЕ lowercase).
 * name      — человекочитаемое имя в UI выбора модели OpenClaw.
 * maxTokens — потолок выдачи (совпадает с max_output из SSOT).
 * aliasFor  — короткий alias в agents.defaults.models.
 */
export interface OpenClawModelSpec {
  id: string;
  name: string;
  maxTokens: number;
  aliasFor?: string;
}

/**
 * Общий context window всех текущих MoE-моделей сети (совпадает с SSOT).
 */
const OPENCLAW_CONTEXT_WINDOW = 131072;

/**
 * Единая тарификация для каталога OpenClaw ($/1M токенов).
 *
 * Значения справочные — реальная тарификация считается на нашей стороне
 * (gateway), здесь они нужны лишь чтобы OpenClaw показывал примерную
 * стоимость в UI. cacheRead/cacheWrite приравнены к input.
 */
const OPENCLAW_COST = {
  input: 0.07,
  output: 0.1,
  cacheRead: 0.07,
  cacheWrite: 0.07,
} as const;

/**
 * Каталог моделей, которые адаптер прописывает в OpenClaw-провайдер `gonka`.
 *
 * Базовые модели (с alias). Порядок совпадает с рабочим конфигом оператора:
 * Kimi — первой (она же primary). Веб-поиск в OpenClaw — через его СОБСТВЕННЫЙ
 * встроенный tools.web (client-side); серверный web_search gateway активируется
 * per-request (plugins mode:'agent') и здесь модель-варианты не нужны.
 * SSOT по id/maxTokens — gateway/src/modules/network-status/model-specs.ts.
 */
export const OPENCLAW_MODELS: readonly OpenClawModelSpec[] = [
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6 (Gonka)', maxTokens: 3072, aliasFor: 'kimi-k2.6' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7 (Gonka)', maxTokens: 4096, aliasFor: 'minimax-m2.7' },
];

/**
 * Модель по умолчанию (primary) для OpenClaw в формате провайдер-ref
 * `<provider>/<modelId>`. Ставится в agents.defaults.model.primary ТОЛЬКО
 * если пользователь ещё не задал свой primary.
 */
export const OPENCLAW_DEFAULT_PRIMARY = `${OPENCLAW_PROVIDER_ID}/moonshotai/Kimi-K2.6`;

/**
 * Сборка JSON-записи модели для каталога провайдера OpenClaw.
 * Вынесено сюда, чтобы форма записи (cost/input/contextWindow) была SSOT
 * и не дублировалась в адаптере/тестах.
 */
export function openclawModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name,
    input: ['text'],
    contextWindow: OPENCLAW_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens,
    cost: { ...OPENCLAW_COST },
  };
}

// --- opencode (https://opencode.ai) — opencode.json (провайдер) + auth.json (ключ, нативно) ---

/** Id нашего провайдера в opencode-конфиге (`provider.<id>`). */
export const OPENCODE_PROVIDER_ID = 'joingonka';

/**
 * npm-пакет AI SDK для OpenAI-совместимого endpoint на /v1/chat/completions.
 * opencode подтягивает его в рантайме сам (ручной npm install не нужен).
 */
export const OPENCODE_NPM = '@ai-sdk/openai-compatible';

/**
 * Ref-подстановка ключа из env синтаксисом `{env:VAR}` (НЕ `${VAR}`).
 * ⚠️ opencode БОЛЬШЕ НЕ использует env — он пишет ключ нативно в
 * ~/.local/share/opencode/auth.json (см. adapters/opencode.ts). Эта константа
 * осталась для адаптера kilo (имя историческое).
 */
export const OPENCODE_API_KEY_REF = `{env:${OPENCLAW_API_KEY_ENV}}`;

/** Модель по умолчанию (top-level `model`): `<provider>/<modelId>`. */
export const OPENCODE_DEFAULT_MODEL = `${OPENCODE_PROVIDER_ID}/moonshotai/Kimi-K2.6`;

/**
 * Запись модели для opencode: `models: { "<id>": { name, limit:{context,output} } }`.
 * limit ОБЯЗАТЕЛЕН — без него opencode не знает остаток контекста (compaction off),
 * а output падает на дефолт. Берём из общего каталога Gonka (OPENCLAW_MODELS).
 */
export function opencodeModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  return {
    name: spec.name,
    limit: { context: OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens },
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
export const AIDER_DEFAULT_MODEL = `${AIDER_MODEL_PREFIX}moonshotai/Kimi-K2.6`;

// --- Kilo Code (https://kilo.ai) — JSONC ~/.config/kilo/kilo.jsonc (OpenCode-формат) ---

/** Id нашего провайдера в kilo.jsonc (`provider.<id>`). */
export const KILO_PROVIDER_ID = 'joingonka';

/** Модель по умолчанию (top-level `model`): `<provider>/<modelId>`. */
export const KILO_DEFAULT_MODEL = `${KILO_PROVIDER_ID}/moonshotai/Kimi-K2.6`;

/**
 * Запись модели для Kilo: `{ name, tool_call, [reasoning], limit:{context,output} }`.
 * `tool_call:true` обязателен (Kilo требует нативный tool-calling); `reasoning:true`
 * для Kimi. `limit` обязателен — иначе Kilo отключает compaction (контекст растёт).
 */
export function kiloModelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: spec.name,
    tool_call: true,
    limit: { context: OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens },
  };
  if (spec.id.includes('Kimi')) entry.reasoning = true;
  return entry;
}

/**
 * Provider-ref модели (`<provider>/<modelId>`) для agents.defaults.models
 * и primary.
 */
export function openclawModelRef(modelId: string): string {
  return `${OPENCLAW_PROVIDER_ID}/${modelId}`;
}
