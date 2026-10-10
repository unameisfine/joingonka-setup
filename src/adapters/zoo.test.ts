/**
 * Тесты адаптера Zoo Code (instructions-only).
 *
 * Zoo Code — преемник Roo Code; провайдер настраивается в UI расширения
 * (API Provider → OpenAI Compatible), ключ уходит в SecretStorage VS Code —
 * файл не пишем. Проверяем: resolvePath→null, wrote:false; поля провайдера
 * (Base URL с /v1, ключ, модель); РЕАЛЬНЫЕ лимиты выбранной модели — в порядке
 * формы Zoo, без несуществующего заголовка «Model Configuration»; в tmp-HOME
 * ничего не появляется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zooAdapter } from './zoo.js';
import {
  DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  GLM_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
} from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-zoo-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: DEFAULT_MODEL, scope: 'user' as const };

describe('zooAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(zooAdapter.id).toBe('zoo');
    expect(zooAdapter.format).toBe('instructions');
    expect(zooAdapter.apiMode).toBe('openai');
    expect(zooAdapter.resolvePath('user')).toBeNull();
    expect(zooAdapter.resolvePath('local')).toBeNull();
    const result = await zooAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('instructions carry the OpenAI Compatible fields (Base URL /v1, key, model)', async () => {
    const { messages } = await zooAdapter.apply(input);
    const text = messages.join('\n');
    expect(text).toContain('Zoo Code');
    expect(text).toContain('API Provider');
    expect(messages).toContain('  API Provider: OpenAI Compatible');
    expect(messages).toContain('  Base URL:     https://gate.joingonka.ai/v1');
    expect(messages).toContain('  API Key:      jg-test123');
    expect(messages).toContain(`  Model:        ${DEFAULT_MODEL}`);
  });

  it('prints the real limits of the selected model for Model Configuration', async () => {
    for (const spec of OPENCLAW_MODELS) {
      const { messages } = await zooAdapter.apply({ ...input, model: spec.id });
      const context = spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW;
      expect(messages).toContain(`  Context Window Size: ${context}`);
      expect(messages).toContain(`  Max Output Tokens:   ${spec.maxTokens}`);
    }
    // Контрольные числа — чтобы цикл выше не «позеленел» вместе с каталогом
    const deepseek = (await zooAdapter.apply({ ...input, model: DEEPSEEK_MODEL })).messages;
    expect(deepseek).toContain('  Context Window Size: 380000');
    expect(deepseek).toContain('  Max Output Tokens:   32768');
    const glm = (await zooAdapter.apply({ ...input, model: GLM_MODEL })).messages;
    expect(glm).toContain('  Context Window Size: 390000');
    expect(glm).toContain('  Max Output Tokens:   8192');
  });

  // Живой прогон Zoo Code 3.82.2 (23.09.2026): блока с заголовком «Model Configuration»
  // в форме нет — поля лимитов стоят ниже в той же форме, причём Max Output Tokens
  // раньше Context Window Size; поле Model форма заранее заполняет gpt-4o.
  it('points at the real form: no "Model Configuration" heading, limits in the form order', async () => {
    const { messages } = await zooAdapter.apply({ ...input, model: DEEPSEEK_MODEL });
    const text = messages.join('\n');
    expect(text).not.toContain('Model Configuration');
    expect(text).toContain('further down the same form');
    const output = messages.indexOf('  Max Output Tokens:   32768');
    const context = messages.indexOf('  Context Window Size: 380000');
    expect(output).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(output);
  });

  it('warns that the form pre-fills Model with gpt-4o', async () => {
    const { messages } = await zooAdapter.apply(input);
    expect(messages.join('\n')).toContain('gpt-4o');
  });

  it('tells the user to leave image support off and mentions native tool calling', async () => {
    const { messages } = await zooAdapter.apply(input);
    expect(messages).toContain('  Image Support:       off');
    expect(messages.join('\n')).toContain('native tool calling');
  });

  it('keeps working for a model id outside the catalog (conservative limits)', async () => {
    const custom = 'acme/brand-new-model';
    const { messages } = await zooAdapter.apply({ ...input, model: custom });
    const minOutput = Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens));
    expect(messages).toContain(`  Model:        ${custom}`);
    expect(messages).toContain(`  Context Window Size: ${OPENCLAW_CONTEXT_WINDOW}`);
    expect(messages).toContain(`  Max Output Tokens:   ${minOutput}`);
    expect(messages.join('\n')).toContain("not in this installer's catalog");
  });

  it('creates no files in the tmp HOME', async () => {
    await zooAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
