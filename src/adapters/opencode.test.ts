/**
 * Контракт-тесты opencode-адаптера: формат сверяется с реальным opencode
 * (docs/providers 2026). Нативная настройка БЕЗ env — два файла:
 *   - opencode.json: npm-адаптер, baseURL с /v1, limit обязателен, БЕЗ apiKey;
 *   - auth.json: ключ под provider-id в формате { type:"api", key } —
 *     то, что пишет `opencode auth login` → Other. Оба merge-aware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { opencodeAdapter } from './opencode.js';

let tmpDir: string;
let configPath: string;
let authPath: string;
let origConfigEnv: string | undefined;
let origAuthEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-opencode-'));
  configPath = join(tmpDir, 'opencode.json');
  authPath = join(tmpDir, 'auth.json');
  origConfigEnv = process.env.OPENCODE_CONFIG;
  origAuthEnv = process.env.OPENCODE_AUTH_JSON;
  process.env.OPENCODE_CONFIG = configPath;
  process.env.OPENCODE_AUTH_JSON = authPath;
});

afterEach(() => {
  if (origConfigEnv === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = origConfigEnv;
  if (origAuthEnv === undefined) delete process.env.OPENCODE_AUTH_JSON;
  else process.env.OPENCODE_AUTH_JSON = origAuthEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function input(overrides?: Partial<{ apiKey: string; model: string }>) {
  return { apiKey: 'jg-test123', model: 'M', scope: 'user' as const, ...overrides };
}
function readConfig(): any {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}
function readAuth(): any {
  return JSON.parse(readFileSync(authPath, 'utf-8'));
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

describe('opencodeAdapter.apply — provider block (opencode.json)', () => {
  it('writes provider.joingonka with @ai-sdk/openai-compatible + baseURL WITH /v1', async () => {
    await opencodeAdapter.apply(input());
    const p = readConfig().provider.joingonka;
    expect(p.npm).toBe('@ai-sdk/openai-compatible');
    expect(p.options.baseURL).toBe('https://gate.joingonka.ai/v1');
  });

  it('does NOT put apiKey in opencode.json (key lives in auth.json, not config)', async () => {
    await opencodeAdapter.apply(input());
    const p = readConfig().provider.joingonka;
    expect(p.options.apiKey).toBeUndefined();
    expect(JSON.stringify(readConfig()).includes('jg-test123')).toBe(false);
  });

  it('writes models with limit.output matching SSOT caps (both 8192)', async () => {
    await opencodeAdapter.apply(input());
    const models = readConfig().provider.joingonka.models;
    expect(models['moonshotai/Kimi-K2.6'].limit.output).toBe(8192);
    expect(models['MiniMaxAI/MiniMax-M2.7'].limit.output).toBe(8192);
    expect(models['moonshotai/Kimi-K2.6'].limit.context).toBeGreaterThan(0);
  });

  it('sets $schema and default top-level model (MiniMax) when absent', async () => {
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.model).toBe('joingonka/MiniMaxAI/MiniMax-M2.7');
  });
});

describe('opencodeAdapter.apply — credential store (auth.json)', () => {
  it('stores the key under provider-id with type:api (opencode native format)', async () => {
    await opencodeAdapter.apply(input());
    expect(readAuth().joingonka).toEqual({ type: 'api', key: 'jg-test123' });
  });

  it('provider-id in auth.json matches provider-id in opencode.json', async () => {
    await opencodeAdapter.apply(input());
    expect(Object.keys(readAuth())).toContain('joingonka');
    expect(readConfig().provider.joingonka).toBeTruthy();
  });
});

describe('opencodeAdapter.apply — merge-aware', () => {
  it('preserves a foreign provider and user top-level model in opencode.json', async () => {
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

  it('убирает устаревшую модель (Qwen) из каталога и сбрасывает наш устаревший дефолт', async () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'joingonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        provider: {
          joingonka: {
            models: {
              'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { name: 'Qwen (old)' },
              'moonshotai/Kimi-K2.6': { name: 'stale name' },
            },
          },
        },
      }),
    );
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    const models = cfg.provider.joingonka.models;
    expect(models['Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined(); // убрана
    expect(models['moonshotai/Kimi-K2.6']).toBeTruthy(); // актуальная есть
    expect(models['MiniMaxAI/MiniMax-M2.7']).toBeTruthy();
    expect(cfg.model).toBe('joingonka/MiniMaxAI/MiniMax-M2.7'); // дефолт на Qwen → сброшен
  });

  it('preserves foreign credentials in auth.json', async () => {
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ openai: { type: 'api', key: 'sk-foreign' } }));
    await opencodeAdapter.apply(input());
    const auth = readAuth();
    expect(auth.openai).toEqual({ type: 'api', key: 'sk-foreign' }); // чужой ключ цел
    expect(auth.joingonka).toEqual({ type: 'api', key: 'jg-test123' }); // наш добавлен
  });
});
