/**
 * Live-проверка записанной настройки: минимальный реальный запрос к gate
 * ключом + baseURL + моделью, которые установщик прописал инструменту.
 *
 * Зачем: установщик может «успешно» записать конфиг, который НЕ работает
 * (мёртвый ключ, неверный baseURL, несуществующая модель, неверный формат
 * ключа — как был OpenClaw-баг с голым именем env). Один запрос ловит это
 * сразу, вместо тихого 401 при первом использовании инструмента.
 *
 * Три режима — по тому, как инструмент обращается к нашему gateway:
 *   - 'openai'    → POST {BASE_URL_OPENAI}/chat/completions, Bearer-ключ;
 *   - 'anthropic' → POST {BASE_URL}/v1/messages, x-api-key (только claude-code);
 *   - 'responses' → POST {BASE_URL_OPENAI}/responses, Bearer-ключ (Codex CLI: другого
 *                   протокола он не умеет, и проверка через chat/completions
 *                   подтверждала бы не тот маршрут шлюза, по которому он пойдёт).
 *
 * ★ Исход различает ТРИ вещи (аудит 19.09.2026). Раньше любой ответ, кроме
 * 200, означал «проверьте ключ» и выход с кодом 2 — под эту формулировку
 * попадали и перегрузка сети (429/503), и пустой баланс (402), и таймаут.
 * Человек с рабочим ключом видел «установка провалилась» и шёл перевыпускать
 * ключ. Теперь: ошибка настройки (ключ/модель/URL) — отказ; временная
 * недоступность — предупреждение при успешной установке; на сетевых заминках
 * делаем повтор.
 */
import { BASE_URL, BASE_URL_OPENAI } from '../constants.js';

/** Что означает результат проверки для пользователя и кода возврата CLI. */
export type VerifyOutcome =
  /** Запрос прошёл — настройка рабочая. */
  | 'ok'
  /** Настройка не работает: ключ, модель или URL. Это провал установки. */
  | 'config'
  /** Сеть/шлюз сейчас заняты или недоступны. Конфиг при этом корректен. */
  | 'unavailable';

export interface VerifyResult {
  /** true только при HTTP 200 от gate. */
  ok: boolean;
  /** Что именно произошло — решает, считать ли установку провалившейся. */
  outcome: VerifyOutcome;
  /** HTTP-статус, либо null при сетевой ошибке/таймауте. */
  status: number | null;
  /** Человекочитаемая деталь (для вывода пользователю). */
  detail: string;
}

const TIMEOUT_MS = 20_000;
/** Стабильная версия Anthropic API (заголовок anthropic-version). */
const ANTHROPIC_VERSION = '2023-06-01';
/** Сколько раз повторяем при временной недоступности (итого до 3 попыток). */
const RETRIES = 2;
/** Пауза между попытками. */
const RETRY_DELAY_MS = 1500;

/**
 * Статусы, которые НЕ говорят ничего плохого о настройке:
 *   429 — лимит/перегрузка, 500/502/503/504 — беда на стороне сети Gonka.
 * 402 (нет средств) выделен отдельно: ключ рабочий, платить — отдельный шаг.
 */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Как инструмент ходит в шлюз — от этого зависит маршрут и форма пробного запроса. */
export type VerifyApiMode = 'openai' | 'anthropic' | 'responses';

/**
 * Потолок ответа в пробе Responses API. У OpenAI значение меньше 16 отвергается
 * (400 integer_below_min_value) — берём документированный минимум, чтобы пробу не
 * отклонил ни наш шлюз (он передаёт число в `max_tokens`), ни строгий валидатор
 * перед ним. Цель та же, что у `max_tokens: 1` в остальных режимах: подтвердить
 * приём ключа, URL и модели, а не получить текст.
 */
const RESPONSES_MAX_OUTPUT_TOKENS = 16;

export interface VerifyOptions {
  apiMode: VerifyApiMode;
  apiKey: string;
  model: string;
  /** Пауза между повторами; 0 в тестах, чтобы не ждать вживую. */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Пробный запрос одного режима: куда, с какими заголовками и телом. */
interface Probe {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Минимальный запрос режима. Цель — подтвердить приём ключа/URL/модели, а не
 * сгенерировать контент, поэтому потолок ответа всюду наименьший допустимый.
 */
function buildProbe({ apiMode, apiKey, model }: VerifyOptions): Probe {
  const bearer = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  const chatBody = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };

  switch (apiMode) {
    case 'anthropic':
      return {
        url: `${BASE_URL}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: chatBody,
      };
    case 'responses':
      // Форма запроса — как у самого Codex по HTTP: `store: false` и никакого
      // `previous_response_id` (шлюз диалогов не хранит и ссылку на прошлый ответ
      // отвергает 400 — gateway, modules/openai-responses/converter.ts).
      return {
        url: `${BASE_URL_OPENAI}/responses`,
        headers: bearer,
        body: {
          model,
          input: 'ping',
          max_output_tokens: RESPONSES_MAX_OUTPUT_TOKENS,
          store: false,
        },
      };
    case 'openai':
    default:
      return { url: `${BASE_URL_OPENAI}/chat/completions`, headers: bearer, body: chatBody };
  }
}

/** Одна попытка запроса. */
async function attempt(opts: VerifyOptions): Promise<VerifyResult> {
  const probe = buildProbe(opts);

  try {
    const res = await fetch(probe.url, {
      method: 'POST',
      headers: probe.headers,
      body: JSON.stringify(probe.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) {
      return { ok: true, outcome: 'ok', status: res.status, detail: 'gateway responded OK' };
    }

    const text = await res.text().catch(() => '');
    const detail = `HTTP ${res.status}: ${text.slice(0, 200)}`;

    if (res.status === 402) {
      return {
        ok: false,
        outcome: 'unavailable',
        status: res.status,
        detail: `${detail} — the key works, the balance is empty. Top up at https://gate.joingonka.ai/billing`,
      };
    }
    if (TRANSIENT_STATUSES.has(res.status)) {
      return { ok: false, outcome: 'unavailable', status: res.status, detail };
    }
    return { ok: false, outcome: 'config', status: res.status, detail };
  } catch (err) {
    // Таймаут/обрыв — про настройку ничего не говорит.
    return {
      ok: false,
      outcome: 'unavailable',
      status: null,
      detail: `network error: ${(err as Error).message}`,
    };
  }
}

/**
 * Проверяет настройку, повторяя запрос при временной недоступности.
 * Ошибки настройки (401/403/400 и прочие) не ретраятся — повтор их не лечит.
 */
export async function verifyConfig(opts: VerifyOptions): Promise<VerifyResult> {
  let last = await attempt(opts);
  const delay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  for (let i = 0; i < RETRIES && last.outcome === 'unavailable' && last.status !== 402; i += 1) {
    await sleep(delay);
    last = await attempt(opts);
  }
  return last;
}
