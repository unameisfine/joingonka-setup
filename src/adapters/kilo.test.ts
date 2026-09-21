/** Контракт-тесты Kilo-адаптера (OpenCode-формат + tool_call/reasoning). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiloAdapter, kiloConfigPath } from './kilo.js';
import { KILO_DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

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
  it('writes provider with @ai-sdk/openai-compatible, baseURL /v1, LITERAL key', async () => {
    await kiloAdapter.apply(input);
    const p = readConfig().provider.joingonka;
    expect(p.npm).toBe('@ai-sdk/openai-compatible');
    expect(p.options.baseURL).toBe('https://gate.joingonka.ai/v1');
    // Литеральный ключ (НЕ {env:...}) — работает без экспортированной переменной.
    expect(p.options.apiKey).toBe('jg-test123');
    expect(JSON.stringify(readConfig()).includes('jg-test123')).toBe(true);
  });

  it('models carry tool_call + limit, GLM carries reasoning', async () => {
    await kiloAdapter.apply(input);
    const models = readConfig().provider.joingonka.models;
    expect(models['zai-org/GLM-5.3-Flash'].tool_call).toBe(true);
    expect(models['zai-org/GLM-5.3-Flash'].reasoning).toBe(true);
    expect(models['zai-org/GLM-5.3-Flash'].limit.output).toBe(8192);
    expect(models['zai-org/GLM-5.3-Flash'].limit.context).toBe(390000);
    expect(models['MiniMaxAI/MiniMax-M2.7'].reasoning).toBeUndefined();
  });

  it('убирает устаревшую модель (Qwen) из каталога и сбрасывает наш устаревший дефолт', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'joingonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        provider: {
          joingonka: {
            models: { 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { name: 'Qwen (old)' } },
          },
        },
      }),
    );
    await kiloAdapter.apply(input);
    const cfg = readConfig();
    const models = cfg.provider.joingonka.models;
    expect(models['Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined(); // убрана
    expect(models['zai-org/GLM-5.3-Flash']).toBeTruthy();
    expect(models['MiniMaxAI/MiniMax-M2.7']).toBeTruthy();
    expect(cfg.model).toBe(KILO_DEFAULT_MODEL); // дефолт на Qwen → сброшен
  });

  it('НЕ трогает пользовательский дефолт на чужой провайдер', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ model: 'anthropic/claude-x', provider: { anthropic: { name: 'A' } } }),
    );
    await kiloAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.model).toBe('anthropic/claude-x'); // чужой дефолт сохранён
    expect(cfg.provider.anthropic).toBeTruthy(); // чужой провайдер цел
    expect(cfg.provider.joingonka).toBeTruthy(); // наш добавлен
  });

  it('sets kilo $schema and the coding-agent default model when absent', async () => {
    await kiloAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.$schema).toBe('https://app.kilo.ai/config.json');
    expect(cfg.model).toBe(KILO_DEFAULT_MODEL);
  });
});

describe('kiloAdapter.apply — сохранность чужого и явная модель (0.4.5)', () => {
  it('keeps comments, trailing commas and foreign providers', async () => {
    // kilo.jsonc — JSONC: в примерах официальной доки есть висячие запятые.
    writeFileSync(
      configPath,
      `{
  // не трогать: мой локальный провайдер
  "provider": { "ollama": { "npm": "ollama-ai-provider", }, },
}`,
    );

    await kiloAdapter.apply(input);

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// не трогать: мой локальный провайдер');
    expect(raw).toContain('"ollama"');
    expect(raw).toContain('"joingonka"');
  });

  it('refuses a config it cannot parse and writes nothing', async () => {
    writeFileSync(configPath, '{ "provider": ');
    await expect(kiloAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ "provider": ');
  });

  it('writes an explicit --model', async () => {
    await kiloAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    expect(readConfig().model).toBe(`joingonka/${GLM_MODEL}`);
  });
});

describe('kiloAdapter.apply — ушедшие модели ВНЕ каталога провайдера (0.4.5)', () => {
  // Kilo — форк opencode, схема та же (packages/core/src/v1/config/*.ts в
  // Kilo-Org/kilocode, 21.09.2026): small_model, agent/mode/command.<имя>.model.
  const KIMI = 'joingonka/moonshotai/Kimi-K2.6';

  it('replaces our retired model everywhere and keeps foreign and live refs', async () => {
    writeFileSync(
      configPath,
      `{
  // мои агенты
  "model": "anthropic/claude-opus-5",
  "small_model": "${KIMI}",
  "agent": {
    "plan": { "model": "${KIMI}" },
    "build": { "model": "anthropic/claude-opus-5" },
  },
  "command": { "test": { "template": "run tests", "model": "${KIMI}" } },
}`,
    );

    const result = await kiloAdapter.apply(input);

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// мои агенты'); // правки точечные, комментарий цел
    expect(raw).not.toContain('Kimi');
    expect(raw).toContain(`"small_model": "${KILO_DEFAULT_MODEL}"`);
    expect(raw).toContain('"model": "anthropic/claude-opus-5"');
    expect(result.messages.join('\n')).toMatch(/3 references.*no longer served/i);
  });

  it('uses an explicit --model as the replacement', async () => {
    writeFileSync(configPath, JSON.stringify({ small_model: KIMI }));

    await kiloAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });

    expect(readConfig().small_model).toBe(`joingonka/${GLM_MODEL}`);
  });
});

describe('kiloConfigPath — где Kilo ищет конфиг (0.4.5)', () => {
  // Kilo считает каталог так же, как opencode: xdgConfig из xdg-basedir + "kilo"
  // (packages/core/src/global.ts); KILO_CONFIG — настоящий флаг Kilo (flag/flag.ts).
  const ctx = (env: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, env, home: '/home/u' });

  it('defaults to ~/.config/kilo/kilo.jsonc', () => {
    expect(kiloConfigPath(ctx({}))).toBe('/home/u/.config/kilo/kilo.jsonc');
  });

  it('honours XDG_CONFIG_HOME', () => {
    expect(kiloConfigPath(ctx({ XDG_CONFIG_HOME: '/x/cfg' }))).toBe('/x/cfg/kilo/kilo.jsonc');
  });

  it('KILO_CONFIG wins over XDG', () => {
    expect(kiloConfigPath(ctx({ XDG_CONFIG_HOME: '/x/cfg', KILO_CONFIG: '/custom/k.jsonc' }))).toBe(
      '/custom/k.jsonc',
    );
  });
});

describe('kiloAdapter.apply — неожиданная форма узла (0.4.5)', () => {
  it('refuses when `provider` is not an object: no write, no backup', async () => {
    const original = '{\n  // мой конфиг\n  "provider": "x",\n}';
    writeFileSync(configPath, original);

    await expect(kiloAdapter.apply(input)).rejects.toThrow(
      /kilo\.jsonc.*"provider" is a string.*Nothing was written/s,
    );

    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readdirSync(tmpDir)).toEqual(['kilo.jsonc']);
  });
});
