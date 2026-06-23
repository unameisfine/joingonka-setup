/** Тесты Roo-адаптера (instructions-only). */
import { describe, it, expect } from 'vitest';
import { rooAdapter } from './roo.js';

const input = { apiKey: 'jg-test123', model: 'moonshotai/Kimi-K2.6', scope: 'user' as const };

describe('rooAdapter', () => {
  it('does not write a file (instructions-only)', async () => {
    expect(rooAdapter.resolvePath('user')).toBeNull();
    expect((await rooAdapter.apply(input)).wrote).toBe(false);
  });

  it('instructions carry OpenAI Compatible fields (Base URL /v1, key, model)', async () => {
    const text = (await rooAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('OpenAI Compatible');
    expect(text).toContain('https://gate.joingonka.ai/v1');
    expect(text).toContain('jg-test123');
    expect(text).toContain('moonshotai/Kimi-K2.6');
  });
});
