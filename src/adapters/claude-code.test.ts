/**
 * Тесты адаптера Claude Code (JSON).
 *
 * Проверяем:
 * - пишет ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (user и local scope)
 * - BASE_URL БЕЗ /v1 (регресс-гард: отличие от OpenAI-инструментов)
 * - сохраняет чужие поля при merge
 * - бэкап создаётся при наличии файла, не создаётся при отсутствии
 * - создаёт родительский каталог
 * - битый JSON → свежий объект + бэкап
 * - идемпотентность (повторный apply → те же значения)
 *
 * HOME перенаправляется в mkdtempSync-каталог, cwd → tmpDir; восстановление
 * в afterEach. Это шаблон из эталонного configure.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from './claude-code.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-cc-test-'));
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

const input = (scope: 'user' | 'local') => ({
  apiKey: 'jg-test123',
  model: DEFAULT_MODEL,
  scope,
});

describe('claudeCodeAdapter.resolvePath', () => {
  it('returns ~/.claude/settings.json for user scope', () => {
    expect(claudeCodeAdapter.resolvePath('user')).toBe(join(tmpDir, '.claude', 'settings.json'));
  });

  it('returns CWD/.claude/settings.local.json for local scope', () => {
    expect(claudeCodeAdapter.resolvePath('local')).toBe(
      join(tmpDir, '.claude', 'settings.local.json'),
    );
  });
});

describe('claudeCodeAdapter.apply', () => {
  it('writes ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL (user scope)', async () => {
    const result = await claudeCodeAdapter.apply(input('user'));
    expect(result.wrote).toBe(true);

    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    expect(result.configPath).toBe(settingsPath);
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('jg-test123');
    expect(content.env.ANTHROPIC_BASE_URL).toBe('https://gate.joingonka.ai');
  });

  it('uses base URL WITHOUT /v1 (regression guard vs OpenAI tools)', async () => {
    await claudeCodeAdapter.apply(input('user'));
    const content = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(content.env.ANTHROPIC_BASE_URL).toBe('https://gate.joingonka.ai');
    expect(content.env.ANTHROPIC_BASE_URL).not.toContain('/v1');
  });

  it('writes to local scope path', async () => {
    await claudeCodeAdapter.apply(input('local'));
    const settingsPath = join(tmpDir, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('jg-test123');
  });

  it('preserves existing non-env and foreign env fields', async () => {
    const dir = join(tmpDir, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Bash'] },
        env: { CUSTOM_VAR: 'keep-me' },
      }),
    );

    await claudeCodeAdapter.apply(input('user'));

    const content = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(content.theme).toBe('dark');
    expect(content.permissions).toEqual({ allow: ['Bash'] });
    expect(content.env.CUSTOM_VAR).toBe('keep-me');
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('jg-test123');
  });

  it('creates a backup when the file already exists', async () => {
    const dir = join(tmpDir, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'old' } }));

    const result = await claudeCodeAdapter.apply(input('user'));

    expect(result.backupPath).not.toBeNull();
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBeGreaterThan(0);
    const backupContent = JSON.parse(readFileSync(join(dir, backups[0]), 'utf-8'));
    expect(backupContent.env.ANTHROPIC_AUTH_TOKEN).toBe('old');
  });

  it('does not create a backup when the file does not exist', async () => {
    const result = await claudeCodeAdapter.apply(input('user'));
    expect(result.backupPath).toBeNull();
    const dir = join(tmpDir, '.claude');
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBe(0);
  });

  it('creates the parent directory if missing', async () => {
    expect(existsSync(join(tmpDir, '.claude'))).toBe(false);
    await claudeCodeAdapter.apply(input('user'));
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(true);
  });

  it('handles malformed existing JSON by starting fresh and backing up', async () => {
    const dir = join(tmpDir, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{ this is not valid json');

    await claudeCodeAdapter.apply(input('user'));

    const content = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('jg-test123');
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('is idempotent — second apply keeps the same values', async () => {
    await claudeCodeAdapter.apply(input('user'));
    await claudeCodeAdapter.apply(input('user'));
    const content = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(content.env.ANTHROPIC_AUTH_TOKEN).toBe('jg-test123');
    expect(content.env.ANTHROPIC_BASE_URL).toBe('https://gate.joingonka.ai');
  });
});
