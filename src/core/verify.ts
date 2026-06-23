/**
 * Live-проверка записанной настройки: минимальный реальный запрос к gate
 * ключом + baseURL + моделью, которые установщик прописал инструменту.
 *
 * Зачем: установщик может «успешно» записать конфиг, который НЕ работает
 * (мёртвый ключ, неверный baseURL, несуществующая модель, неверный формат
 * ключа — как был OpenClaw-баг с голым именем env). Один запрос ловит это
 * сразу, вместо тихого 401 при первом использовании инструмента.
 *
 * Два режима — по тому, как инструмент обращается к нашему gateway:
 *   - 'openai'    → POST {BASE_URL_OPENAI}/chat/completions, Bearer-ключ;
 *   - 'anthropic' → POST {BASE_URL}/v1/messages, x-api-key (только claude-code).
 */
import { BASE_URL, BASE_URL_OPENAI } from '../constants.js';

export interface VerifyResult {
  /** true только при HTTP 200 от gate. */
  ok: boolean;
  /** HTTP-статус, либо null при сетевой ошибке/таймауте. */
  status: number | null;
  /** Человекочитаемая деталь (для вывода пользователю). */
  detail: string;
}

const TIMEOUT_MS = 20_000;
/** Стабильная версия Anthropic API (заголовок anthropic-version). */
const ANTHROPIC_VERSION = '2023-06-01';

export interface VerifyOptions {
  apiMode: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}

export async function verifyConfig(opts: VerifyOptions): Promise<VerifyResult> {
  const { apiMode, apiKey, model } = opts;
  // Минимальный запрос: 1 токен. Цель — подтвердить приём ключа/URL/модели,
  // а не сгенерировать контент.
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res =
      apiMode === 'anthropic'
        ? await fetch(`${BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body,
            signal,
          })
        : await fetch(`${BASE_URL_OPENAI}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal,
          });

    if (res.ok) {
      return { ok: true, status: res.status, detail: 'gateway responded OK' };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, status: null, detail: `network error: ${(err as Error).message}` };
  }
}
