/**
 * Тесты адаптера JetBrains AI Assistant (instructions-only).
 *
 * Провайдер добавляется в UI IDE (Settings → Tools → AI Assistant →
 * Providers & API keys), файл не пишем. Проверяем: resolvePath→null,
 * wrote:false, messages содержат путь настроек, base URL с /v1, модель,
 * ключ и честное ограничение про Junie; в tmp-HOME ничего не появляется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jetbrainsAdapter } from './jetbrains.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-jb-test-'));
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

describe('jetbrainsAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(jetbrainsAdapter.resolvePath('user')).toBeNull();
    expect(jetbrainsAdapter.resolvePath('local')).toBeNull();
    const result = await jetbrainsAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('returns messages with the settings path, base URL /v1, model and key', async () => {
    const result = await jetbrainsAdapter.apply(input);
    const joined = result.messages.join('\n');
    expect(joined).toContain('Providers & API keys');
    expect(joined).toContain('https://gate.joingonka.ai/v1');
    expect(joined).toContain(DEFAULT_MODEL);
    expect(joined).toContain('jg-test123');
    // Честное ограничение: Junie остаётся на облаке JetBrains
    expect(joined).toContain('Junie');
  });

  it('creates no files in the tmp HOME', async () => {
    await jetbrainsAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });

  // https://www.jetbrains.com/help/ai-assistant/use-custom-models.html (ред. 28.07.2026)
  it('tells to enable Tool calling — without it the models get no MCP tools', async () => {
    const joined = (await jetbrainsAdapter.apply(input)).messages.join('\n');
    expect(joined).toMatch(/Tool calling:\s+enabled/);
    expect(joined).toContain('Test Connection');
    expect(joined).toContain('Apply');
  });

  it('gives the context window to enter (the IDE default is 64000)', async () => {
    const joined = (await jetbrainsAdapter.apply(input)).messages.join('\n');
    expect(joined).toMatch(/Context window:\s+180000/);
    expect(joined).toContain('8192');
  });

  it('names exactly what stays on JetBrains models', async () => {
    const joined = (await jetbrainsAdapter.apply(input)).messages.join('\n');
    // По доке — code completion и next edit suggestions (им нужны FIM/edit-prediction
    // модели); Junie — по activate-agents.html: API key (BYOK) «Not supported».
    expect(joined).toMatch(/code completion/i);
    expect(joined).toMatch(/next edit suggestions/i);
    expect(joined).toContain('Junie');
  });
});
