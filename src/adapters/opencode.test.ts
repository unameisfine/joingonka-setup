/**
 * Контракт-тесты opencode-адаптера: формат провайдера сверяется с реальным
 * opencode-конфигом (research 2026) — npm-адаптер, baseURL с /v1, ключ как
 * {env:...} (не литерал), limit обязателен, merge-aware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { opencodeAdapter } from './opencode.js';

let tmpDir: string;
let configPath: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-opencode-'));
  configPath = join(tmpDir, 'opencode.json');
  originalEnv = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG = configPath;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function input(overrides?: Partial<{ apiKey: string; model: string }>) {
  return { apiKey: 'jg-test123', model: 'M', scope: 'user' as const, ...overrides };
}
function readConfig(): any {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

describe('opencodeAdapter.resolvePath', () => {
  it('honours OPENCODE_CONFIG when set', () => {
    expect(opencodeAdapter.resolvePath('user')).toBe(configPath);
  });
  it('defaults to ~/.config/opencode/opencode.json', () => {
    delete process.env.OPENCODE_CONFIG;
    expect(opencodeAdapter.resolvePath('user')).toMatch(/\.config\/opencode\/opencode\.json$/);
    process.env.OPENCODE_CONFIG = configPath;
  });
});

describe('opencodeAdapter.apply — provider block', () => {
  it('writes provider.joingonka with @ai-sdk/openai-compatible + baseURL WITH /v1', async () => {
    await opencodeAdapter.apply(input());
    const p = readConfig().provider.joingonka;
    expect(p.npm).toBe('@ai-sdk/openai-compatible');
    expect(p.options.baseURL).toBe('https://gate.joingonka.ai/v1');
  });

  it('writes apiKey as {env:GONKA_API_KEY} ref, not the secret or bare name', async () => {
    await opencodeAdapter.apply(input());
    expect(readConfig().provider.joingonka.options.apiKey).toBe('{env:GONKA_API_KEY}');
    expect(JSON.stringify(readConfig()).includes('jg-test123')).toBe(false);
  });

  it('writes models with limit.output matching SSOT caps (Kimi 3072, Qwen 8192)', async () => {
    await opencodeAdapter.apply(input());
    const models = readConfig().provider.joingonka.models;
    expect(models['moonshotai/Kimi-K2.6'].limit.output).toBe(3072);
    expect(models['Qwen/Qwen3-235B-A22B-Instruct-2507-FP8'].limit.output).toBe(8192);
    expect(models['moonshotai/Kimi-K2.6'].limit.context).toBeGreaterThan(0);
  });

  it('sets $schema and default top-level model (Kimi) when absent', async () => {
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.model).toBe('joingonka/moonshotai/Kimi-K2.6');
  });
});

describe('opencodeAdapter.apply — merge-aware', () => {
  it('preserves a foreign provider and user top-level model', async () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: 'anthropic/claude-x', provider: { anthropic: { name: 'A' } } }),
    );
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.provider.anthropic).toBeTruthy(); // чужой провайдер цел
    expect(cfg.provider.joingonka).toBeTruthy(); // наш добавлен
    expect(cfg.model).toBe('anthropic/claude-x'); // пользовательский model не перезаписан
  });
});
