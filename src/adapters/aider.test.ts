/** Тесты Aider-адаптера (instructions-only, env-based). */
import { describe, it, expect } from 'vitest';
import { aiderAdapter } from './aider.js';

const input = { apiKey: 'jg-test123', model: 'moonshotai/Kimi-K2.6', scope: 'user' as const };

describe('aiderAdapter', () => {
  it('does not write a file (resolvePath null, wrote false)', async () => {
    expect(aiderAdapter.resolvePath('user')).toBeNull();
    const r = await aiderAdapter.apply(input);
    expect(r.wrote).toBe(false);
    expect(r.configPath).toBeNull();
  });

  it('instructions set OPENAI_API_BASE (with /v1) and OPENAI_API_KEY', async () => {
    const text = (await aiderAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('export OPENAI_API_BASE=https://gate.joingonka.ai/v1');
    expect(text).toContain('export OPENAI_API_KEY=jg-test123');
  });

  it('model gets the mandatory openai/ prefix (litellm routing)', async () => {
    const text = (await aiderAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('aider --model openai/moonshotai/Kimi-K2.6');
  });

  it('uses OpenAI verify mode', () => {
    expect(aiderAdapter.apiMode).toBe('openai');
  });
});
