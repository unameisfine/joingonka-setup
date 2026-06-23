/** Контракт-тесты Kilo-адаптера (OpenCode-формат + tool_call/reasoning). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiloAdapter } from './kilo.js';

let tmpDir: string;
let configPath: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-kilo-'));
  configPath = join(tmpDir, 'kilo.jsonc');
  originalEnv = process.env.KILO_CONFIG;
  process.env.KILO_CONFIG = configPath;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.KILO_CONFIG;
  else process.env.KILO_CONFIG = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: 'M', scope: 'user' as const };
const readConfig = (): any => JSON.parse(readFileSync(configPath, 'utf-8'));

describe('kiloAdapter.apply', () => {
  it('writes provider with @ai-sdk/openai-compatible, baseURL /v1, {env} key', async () => {
    await kiloAdapter.apply(input);
    const p = readConfig().provider.joingonka;
    expect(p.npm).toBe('@ai-sdk/openai-compatible');
    expect(p.options.baseURL).toBe('https://gate.joingonka.ai/v1');
    expect(p.options.apiKey).toBe('{env:GONKA_API_KEY}');
    expect(JSON.stringify(readConfig()).includes('jg-test123')).toBe(false);
  });

  it('models carry tool_call + limit, Kimi carries reasoning', async () => {
    await kiloAdapter.apply(input);
    const models = readConfig().provider.joingonka.models;
    expect(models['moonshotai/Kimi-K2.6'].tool_call).toBe(true);
    expect(models['moonshotai/Kimi-K2.6'].reasoning).toBe(true);
    expect(models['moonshotai/Kimi-K2.6'].limit.output).toBe(3072);
    expect(models['Qwen/Qwen3-235B-A22B-Instruct-2507-FP8'].reasoning).toBeUndefined();
  });

  it('sets kilo $schema and default model when absent', async () => {
    await kiloAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.$schema).toBe('https://app.kilo.ai/config.json');
    expect(cfg.model).toBe('joingonka/moonshotai/Kimi-K2.6');
  });
});
