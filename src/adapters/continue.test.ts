/** Тесты Continue-адаптера (instructions-only, YAML-блок). */
import { describe, it, expect } from 'vitest';
import { continueAdapter } from './continue.js';

const input = { apiKey: 'jg-test123', model: 'zai-org/GLM-5.3-Flash', scope: 'user' as const };

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
    expect(text).toContain('model: zai-org/GLM-5.3-Flash');
    expect(text).toContain('roles:');
  });

  // Без capabilities Continue не даёт модели инструментов: modelSupportsNativeTools
  // спрашивает PROVIDER_TOOL_SUPPORT['openai'], а тот знает только gpt-*/o*/codex*.
  // Итог у пользователя — «режим агента не работает» (тикет #9, 24.08.2026).
  it('YAML block declares tool_use — otherwise Continue disables agent mode', async () => {
    const text = (await continueAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('capabilities: [tool_use]');
  });

  // https://docs.continue.dev/reference (исходник docs/reference.mdx): name, version
  // и schema — «required»; без них новый config.yaml не загрузится.
  it('gives the required header for a brand-new config.yaml', async () => {
    const text = (await continueAdapter.apply(input)).messages.join('\n');
    expect(text).toMatch(/^\s*name: /m);
    expect(text).toMatch(/^\s*version: /m);
    expect(text).toContain('schema: v1');
    expect(text).toMatch(/^\s*models:/m);
  });

  it('declares the real limits of the chosen model', async () => {
    const text = (await continueAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('defaultCompletionOptions:');
    expect(text).toContain('contextLength: 390000');
    expect(text).toContain('maxTokens: 8192');
  });

  it('is honest that Continue is no longer developed', async () => {
    // continue.dev (21.09.2026): «Continue has joined Cursor»; README репозитория:
    // «no longer actively maintained and is read-only», финальный релиз 2.0.0.
    const text = (await continueAdapter.apply(input)).messages.join('\n');
    expect(text).toMatch(/acquired by Cursor/i);
    expect(text).toMatch(/no longer (actively )?(maintained|developed)/i);
  });
});
