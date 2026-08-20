/**
 * Тесты адаптера Cursor (instructions-only).
 *
 * Cursor настраивается через UI (Settings → Models), файл не пишем.
 * Проверяем: resolvePath→null, wrote:false, messages содержат base URL с /v1,
 * модель, ключ и предупреждение про Pro-план (BYOK недоступен на free);
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

  it('returns messages with base URL /v1, model, key and the Pro-plan caveat', async () => {
    const result = await cursorAdapter.apply(input);
    const joined = result.messages.join('\n');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
    // BYOK в Cursor только с Pro-плана — обязаны предупредить
    expect(joined).toContain('Pro plan');
  });

  it('creates no files in the tmp HOME', async () => {
    await cursorAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
