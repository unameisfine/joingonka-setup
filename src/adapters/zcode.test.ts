/**
 * Тесты адаптера ZCode (instructions-only).
 *
 * ZCode хранит провайдеры в собственном хранилище (UI), env не читает —
 * файл не пишем. Проверяем: resolvePath→null, wrote:false, messages содержат
 * оба base URL (OpenAI С /v1 для основного пути и Anthropic БЕЗ пути для
 * старых версий), модель, ключ и Context window из каталога
 * (пер-модельный 380000 у DeepSeek, общий 200000 у остальных).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zcodeAdapter } from './zcode.js';
import { DEFAULT_MODEL, DEEPSEEK_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-zcode-test-'));
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

describe('zcodeAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(zcodeAdapter.resolvePath('user')).toBeNull();
    expect(zcodeAdapter.resolvePath('local')).toBeNull();
    const result = await zcodeAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('returns messages with both base URLs, model and key', async () => {
    const result = await zcodeAdapter.apply(input);
    const joined = result.messages.join('\n');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    // Anthropic Base URL для старых версий — домен БЕЗ пути
    expect(joined).toMatch(/Anthropic Base URL: https:\/\/gate\.joingonka\.ai\s/);
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
  });

  it('shows the shared context window (200000) for the default model', async () => {
    const result = await zcodeAdapter.apply(input);
    expect(result.messages.join('\n')).toContain('Context window: 200000');
  });

  it('shows the per-model context window (380000) for DeepSeek', async () => {
    const result = await zcodeAdapter.apply({ ...input, model: DEEPSEEK_MODEL });
    expect(result.messages.join('\n')).toContain('Context window: 380000');
  });

  it('creates no files in the tmp HOME', async () => {
    await zcodeAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
