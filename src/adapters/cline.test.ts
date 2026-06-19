/**
 * Тесты адаптера Cline (instructions-only).
 *
 * Cline настраивается через UI VS Code, конфиг-файла на диске у него нет
 * (в смысле — мы его не пишем). Адаптер только возвращает готовые значения
 * для ручного ввода в панель.
 *
 * Проверяем:
 * - resolvePath() → null (писать некуда)
 * - apply() НЕ пишет файл: wrote:false, configPath:null, backupPath:null
 * - messages содержат base URL с /v1 + модель + ключ
 * - в tmp-HOME не появляется никаких файлов
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clineAdapter } from './cline.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-cline-test-'));
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

describe('clineAdapter.resolvePath', () => {
  it('returns null for any scope (instructions-only)', () => {
    expect(clineAdapter.resolvePath('user')).toBeNull();
    expect(clineAdapter.resolvePath('local')).toBeNull();
  });
});

describe('clineAdapter.apply', () => {
  it('does not write a file: wrote false, paths null', async () => {
    const result = await clineAdapter.apply({
      apiKey: 'jg-test123',
      model: DEFAULT_MODEL,
      scope: 'user',
    });
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('returns messages with base URL /v1, model and api key', async () => {
    const result = await clineAdapter.apply({
      apiKey: 'jg-test123',
      model: DEFAULT_MODEL,
      scope: 'user',
    });
    const joined = result.messages.join('\n');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
  });

  it('creates no files in the tmp HOME', async () => {
    await clineAdapter.apply({
      apiKey: 'jg-test123',
      model: DEFAULT_MODEL,
      scope: 'user',
    });
    // Каталог HOME остаётся пустым — адаптер ничего не пишет
    const entries = readdirSync(tmpDir);
    expect(entries.length).toBe(0);
  });
});
