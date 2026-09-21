/**
 * Живые цены моделей — публичный GET /api/pricing шлюза.
 *
 * ★ Зачем. OpenClaw, Pi, omp и Crush хранят в записи модели цену ($ за 1M токенов)
 * и показывают по ней стоимость сессии в своём UI. Цена шлюза фиксирована в GNK
 * (33/99 nGNK за токен), а в долларах плавает вместе с курсом GNK, поэтому
 * константа в пакете стареет с первого дня: до 0.4.5 там стояли 0.07/0.1 и UI
 * завышал стоимость в 5–11 раз. Берём значение в момент установки.
 *
 * ★ Свойство, которое нельзя сломать: цена — справочная, и установка из-за неё
 * падать НЕ должна. Любая беда (нет сети, не-200, мусор в теле, таймаут) даёт
 * `null`. Тогда функции записи модели (constants.ts, modelCost) оставляют цену,
 * УЖЕ записанную у этой модели в конфиге, а константу-фолбэк берут только для
 * новой записи — иначе повторный запуск при недоступном шлюзе затирал бы живую
 * цену прошлого запуска более грубой константой (так было до второй части 0.5.0).
 *
 * Форма ответа (сверено живым запросом 21.09.2026):
 *   { "models": [ { "model_id": "MiniMaxAI/MiniMax-M2.7",
 *                   "usd_per_million_tokens": 0.005808,   // вход
 *                   "usd_per_million_output": 0.017424,   // выход
 *                   "ngonka_per_token_input": 33, ... } ], ... }
 */
import { BASE_URL, type ModelPrice } from '../constants.js';

/**
 * Цены на момент установки.
 *
 * `input`/`output` — цена ПЕРВОЙ модели ответа: на 21.09.2026 цена у всех
 * моделей сети одна, и это общий случай. `byModel` заполняется только когда
 * цены у моделей различаются — тогда адаптер берёт пер-модельную через priceFor.
 */
export interface LivePricing extends ModelPrice {
  byModel?: Readonly<Record<string, ModelPrice>>;
}

const PRICING_URL = `${BASE_URL}/api/pricing`;

/**
 * Три секунды: запрос идёт ДО записи конфига, и человек ждёт его вживую.
 * Недоступный шлюз не должен превращать установку в полуминутное молчание.
 */
const TIMEOUT_MS = 3000;

/** Шесть знаков после запятой — точность ответа шлюза; дальше шум float. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Годная цена: конечное положительное число (ноль и отрицательное — мусор). */
function asPrice(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? round6(value) : undefined;
}

/** Разбирает тело ответа; undefined — в теле нет ни одной годной записи. */
function parsePricing(body: unknown): LivePricing | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;

  const byModel: Record<string, ModelPrice> = {};
  let first: ModelPrice | undefined;
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const input = asPrice(record.usd_per_million_tokens);
    const output = asPrice(record.usd_per_million_output);
    if (typeof record.model_id !== 'string' || input === undefined || output === undefined) continue;
    byModel[record.model_id] = { input, output };
    first ??= { input, output };
  }
  if (!first) return undefined;

  const base: ModelPrice = first;
  const uniform = Object.values(byModel).every(
    (p) => p.input === base.input && p.output === base.output,
  );
  return uniform ? { ...base } : { ...base, byModel };
}

/**
 * Запрашивает живые цены. Никогда не бросает: `null` означает «цен нет,
 * работаем с константой».
 */
export async function fetchLivePricing(): Promise<LivePricing | null> {
  try {
    const res = await fetch(PRICING_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // text() + JSON.parse, а не json(): так же читает ответы core/verify, и
    // заглушки fetch в тестах оркестратора отдают только text().
    return parsePricing(JSON.parse(await res.text())) ?? null;
  } catch {
    return null;
  }
}

/**
 * Цена конкретной модели: пер-модельная, если цены различаются, иначе общая.
 * `undefined` — цен нет вовсе: вызывающий оставляет уже записанную цену, а для
 * новой записи берёт константу-фолбэк.
 */
export function priceFor(
  pricing: LivePricing | null | undefined,
  modelId: string,
): ModelPrice | undefined {
  if (!pricing) return undefined;
  const own = pricing.byModel?.[modelId];
  return own ?? { input: pricing.input, output: pricing.output };
}
