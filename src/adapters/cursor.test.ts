/**
 * Тесты адаптера Cursor (instructions-only).
 *
 * Cursor настраивается через UI (Settings → Models), файл не пишем.
 * Проверяем: resolvePath→null, wrote:false, messages содержат base URL с /v1,
 * модель, ключ, лимиты модели и ограничения из доки Cursor;
 * в tmp-HOME ничего не появляется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorAdapter } from './cursor.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-cursor-test-'));
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

describe('cursorAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(cursorAdapter.resolvePath('user')).toBeNull();
    expect(cursorAdapter.resolvePath('local')).toBeNull();
    const result = await cursorAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('returns messages with base URL /v1, model and key', async () => {
    const result = await cursorAdapter.apply(input);
    const joined = result.messages.join('\n');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
  });

  it('does not claim a paid plan is required — the official page does not say so', async () => {
    // https://cursor.com/docs/settings/api-keys (21.09.2026): про тариф сказано
    // лишь, как BYOK считается в лимитах; требования «Pro и выше» там нет.
    const joined = (await cursorAdapter.apply(input)).messages.join('\n');
    expect(joined).not.toMatch(/Pro plan|requires a/i);
  });

  it('states the two limitations Cursor itself documents', async () => {
    const joined = (await cursorAdapter.apply(input)).messages.join('\n');
    // Дока: «Custom API keys only work with chat models. Tab completion continues
    // using Cursor's built-in models.»
    expect(joined).toContain('only work with chat models');
    expect(joined).toContain('Tab');
    // Сотрудник Cursor на форуме (21.08.2026): при включённом Override ВСЕ
    // запросы семейства OpenAI идут на свой endpoint, в т.ч. встроенные модели.
    expect(joined).toMatch(/switch the override off/i);
  });

  it('prints the real limits of the chosen model', async () => {
    const joined = (await cursorAdapter.apply(input)).messages.join('\n');
    expect(joined).toContain('context window 180000 tokens, max output 8192 tokens');
  });

  it('creates no files in the tmp HOME', async () => {
    await cursorAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
