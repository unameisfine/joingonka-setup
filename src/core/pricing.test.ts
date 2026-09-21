/**
 * Тесты живых цен (GET /api/pricing шлюза).
 *
 * Сеть не трогаем: fetch подменяется. Проверяем разбор ответа, выбор «одна цена
 * на всех / карта по моделям» и главное свойство — ЛЮБАЯ беда (сеть, статус,
 * мусор в теле) даёт null, а не исключение: цена в конфиге справочная, и из-за
 * неё установка падать не должна.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLivePricing, priceFor } from './pricing.js';

afterEach(() => vi.unstubAllGlobals());

/** Ответ шлюза в реальной форме (срез 21.09.2026, лишние поля оставлены намеренно). */
function pricingBody(models: unknown[]) {
  return JSON.stringify({ usage_fee_percent: 10, gnk_usd_price: 0.176, models });
}

function respond(body: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const SAME = [
  {
    model_id: 'MiniMaxAI/MiniMax-M2.7',
    usd_per_million_tokens: 0.005808,
    usd_per_million_output: 0.017424,
    ngonka_per_token_input: 33,
    ngonka_per_token_output: 99,
  },
  {
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    usd_per_million_tokens: 0.005808,
    usd_per_million_output: 0.017424,
  },
];

describe('fetchLivePricing — разбор ответа', () => {
  it('одна цена на все модели → {input, output} по первой модели, без карты', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(pricingBody(SAME))));

    const pricing = await fetchLivePricing();

    expect(pricing).toEqual({ input: 0.005808, output: 0.017424 });
    expect(pricing?.byModel).toBeUndefined();
  });

  it('цены у моделей разные → карта по model_id, общая цена — по первой модели', async () => {
    const models = [
      SAME[0],
      { model_id: 'zai-org/GLM-5.3-Flash', usd_per_million_tokens: 0.01, usd_per_million_output: 0.03 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(pricingBody(models))));

    const pricing = await fetchLivePricing();

    expect(pricing?.input).toBe(0.005808);
    expect(pricing?.byModel).toEqual({
      'MiniMaxAI/MiniMax-M2.7': { input: 0.005808, output: 0.017424 },
      'zai-org/GLM-5.3-Flash': { input: 0.01, output: 0.03 },
    });
  });

  it('ходит GET-ом на /api/pricing шлюза и ставит таймаут', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(pricingBody(SAME)));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLivePricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.joingonka.ai/api/pricing');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Ключ сюда не уходит: эндпоинт публичный.
    expect(JSON.stringify(opts)).not.toContain('jg-');
  });

  it('срезает шум плавающей точки до шести знаков', async () => {
    const models = [
      { model_id: 'a/b', usd_per_million_tokens: 0.005808000000000001, usd_per_million_output: 0.0174239999 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(pricingBody(models))));

    expect(await fetchLivePricing()).toEqual({ input: 0.005808, output: 0.017424 });
  });

  it('пропускает битые записи, но берёт первую годную', async () => {
    const models = [
      { model_id: 'x/broken', usd_per_million_tokens: 'free', usd_per_million_output: 1 },
      { model_id: 'x/zero', usd_per_million_tokens: 0, usd_per_million_output: 0 },
      SAME[0],
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(pricingBody(models))));

    expect(await fetchLivePricing()).toEqual({ input: 0.005808, output: 0.017424 });
  });
});

describe('fetchLivePricing — любая беда даёт null', () => {
  it('не-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('oops', 503)));
    expect(await fetchLivePricing()).toBeNull();
  });

  it('сетевая ошибка или таймаут', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    expect(await fetchLivePricing()).toBeNull();
  });

  it('тело не JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('<html>502</html>')));
    expect(await fetchLivePricing()).toBeNull();
  });

  it('нет массива models (в том числе ответ-заглушка «{}» из тестов оркестратора)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('{}')));
    expect(await fetchLivePricing()).toBeNull();
  });

  it('ни одной годной записи', async () => {
    const models = [{ model_id: 'a/b', usd_per_million_tokens: -1, usd_per_million_output: Number.NaN }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(pricingBody(models))));
    expect(await fetchLivePricing()).toBeNull();
  });
});

describe('priceFor', () => {
  it('нет цен → undefined (вызывающий упадёт на константы)', () => {
    expect(priceFor(undefined, 'a/b')).toBeUndefined();
    expect(priceFor(null, 'a/b')).toBeUndefined();
  });

  it('единая цена → она же для любой модели', () => {
    expect(priceFor({ input: 1, output: 2 }, 'a/b')).toEqual({ input: 1, output: 2 });
  });

  it('карта по моделям → цена модели, для незнакомой — общая', () => {
    const pricing = { input: 1, output: 2, byModel: { 'a/b': { input: 5, output: 6 } } };
    expect(priceFor(pricing, 'a/b')).toEqual({ input: 5, output: 6 });
    expect(priceFor(pricing, 'c/d')).toEqual({ input: 1, output: 2 });
  });
});
