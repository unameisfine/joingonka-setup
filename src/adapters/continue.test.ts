/** Тесты Continue-адаптера (instructions-only, YAML-блок). */
import { describe, it, expect } from 'vitest';
import { continueAdapter } from './continue.js';

const input = { apiKey: 'jg-test123', model: 'moonshotai/Kimi-K2.6', scope: 'user' as const };

describe('continueAdapter', () => {
  it('does not write a file (instructions-only)', async () => {
    expect(continueAdapter.resolvePath('user')).toBeNull();
    expect((await continueAdapter.apply(input)).wrote).toBe(false);
  });

  it('YAML block uses provider:openai + apiBase /v1 + key + model + roles', async () => {
    const text = (await continueAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('provider: openai');
    expect(text).toContain('apiBase: https://gate.joingonka.ai/v1');
    expect(text).toContain('apiKey: jg-test123');
    expect(text).toContain('model: moonshotai/Kimi-K2.6');
    expect(text).toContain('roles:');
  });
});
