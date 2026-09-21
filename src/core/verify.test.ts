/**
 * Тесты live-проверки записанной настройки против gate.
 * verifyConfig делает минимальный реальный запрос ключом+URL+моделью и
 * подтверждает, что инструмент сможет работать (ловит мёртвый ключ/URL/модель —
 * именно тот класс молчаливого провала, что дал OpenClaw-баг).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyConfig } from './verify.js';

afterEach(() => vi.unstubAllGlobals());

function okResponse() {
  return { ok: true, status: 200, text: async () => '{}' };
}

describe('verifyConfig — OpenAI-режим', () => {
  it('POST на /v1/chat/completions с Bearer-ключом и точной моделью', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyConfig({ apiMode: 'openai', apiKey: 'jg-x', model: 'MiniMaxAI/M' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.joingonka.ai/v1/chat/completions');
    expect(opts.headers.authorization).toBe('Bearer jg-x');
    expect(JSON.parse(opts.body).model).toBe('MiniMaxAI/M');
  });
});

describe('verifyConfig — Anthropic-режим (claude-code)', () => {
  it('POST на /v1/messages с x-api-key + anthropic-version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyConfig({ apiMode: 'anthropic', apiKey: 'jg-x', model: 'M' });
    expect(r.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.joingonka.ai/v1/messages');
    expect(opts.headers['x-api-key']).toBe('jg-x');
    expect(opts.headers['anthropic-version']).toBeTruthy();
  });
});

describe('verifyConfig — провалы', () => {
  it('не-ok статус (401 мёртвый ключ) → ok:false с деталью', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid key' });
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyConfig({ apiMode: 'openai', apiKey: 'jg-bad', model: 'M' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toContain('401');
  });

  it('сетевая ошибка → ok:false, status null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await verifyConfig({ apiMode: 'openai', apiKey: 'jg-x', model: 'M' });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.detail).toContain('ECONNREFUSED');
  });
});

describe('verifyConfig — классификация исхода (0.4.5)', () => {
  const opts = {
    apiMode: 'openai' as const,
    apiKey: 'jg-test',
    model: 'MiniMaxAI/MiniMax-M2.7',
    retryDelayMs: 0,
  };

  it('treats 401 as a configuration failure', async () => {
    globalThis.fetch = (async () =>
      new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const res = await verifyConfig(opts);
    expect(res.outcome).toBe('config');
    expect(res.ok).toBe(false);
  });

  it('treats 402 as a working key with an empty balance, without retrying', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('no funds', { status: 402 });
    }) as unknown as typeof fetch;

    const res = await verifyConfig(opts);

    expect(res.outcome).toBe('unavailable');
    expect(res.detail).toMatch(/the key works/i);
    expect(calls).toBe(1);
  });

  it('retries a busy network and succeeds on a later attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls < 3 ? new Response('busy', { status: 429 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await verifyConfig(opts);

    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('reports an overloaded gateway as unavailable, not as a bad key', async () => {
    globalThis.fetch = (async () =>
      new Response('upstream busy', { status: 503 })) as unknown as typeof fetch;
    const res = await verifyConfig(opts);
    expect(res.outcome).toBe('unavailable');
  });
});
