/** Тесты Aider-адаптера (instructions-only, env-based). */
import { describe, it, expect } from 'vitest';
import { aiderAdapter } from './aider.js';

const input = { apiKey: 'jg-test123', model: 'zai-org/GLM-5.3-Flash', scope: 'user' as const };

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
    expect(text).toContain('aider --model openai/zai-org/GLM-5.3-Flash');
  });

  it('uses OpenAI verify mode', () => {
    expect(aiderAdapter.apiMode).toBe('openai');
  });

  // https://aider.chat/docs/config/adv-model-settings.html (21.09.2026): лимиты
  // незнакомой модели регистрируются в .aider.model.metadata.json, имя — с тем же
  // префиксом провайдера, что и в --model.
  it('gives the real limits as an optional .aider.model.metadata.json', async () => {
    const text = (await aiderAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('.aider.model.metadata.json');
    expect(text).toContain('"openai/zai-org/GLM-5.3-Flash"');
    expect(text).toContain('"max_input_tokens": 390000');
    expect(text).toContain('"max_output_tokens": 8192');
    expect(text).toContain('"litellm_provider": "openai"');
  });
});
