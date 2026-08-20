/**
 * Тесты адаптера GitHub Copilot BYOK (instructions-only).
 *
 * BYOK настраивается в UI (Settings → Model Providers), ключ уходит в
 * keychain — файл не пишем. Проверяем: resolvePath→null, wrote:false,
 * messages содержат endpoint с /v1, модель, ключ, пометку про premium-квоту
 * и ограничение inline suggestions; в tmp-HOME ничего не появляется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotByokAdapter } from './copilot-byok.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-copilot-test-'));
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

describe('copilotByokAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(copilotByokAdapter.resolvePath('user')).toBeNull();
    expect(copilotByokAdapter.resolvePath('local')).toBeNull();
    const result = await copilotByokAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('returns messages with Model Providers path, endpoint /v1, model and key', async () => {
    const result = await copilotByokAdapter.apply(input);
    const joined = result.messages.join('\n');
    expect(joined).toContain('Model Providers');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
    // BYOK не тратит premium-квоту — ключевое ценностное сообщение
    expect(joined).toContain('premium quota');
  });

  it('creates no files in the tmp HOME', async () => {
    await copilotByokAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
