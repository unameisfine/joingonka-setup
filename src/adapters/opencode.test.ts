/**
 * Контракт-тесты opencode-адаптера: формат сверяется с реальным opencode
 * (docs/providers 2026). Нативная настройка БЕЗ env — два файла:
 *   - opencode.json: npm-адаптер, baseURL с /v1, limit обязателен, БЕЗ apiKey;
 *   - auth.json: ключ под provider-id в формате { type:"api", key } —
 *     то, что пишет `opencode auth login` → Other. Оба merge-aware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { opencodeAdapter, opencodePaths } from './opencode.js';
import { OPENCODE_DEFAULT_MODEL, DEEPSEEK_MODEL, GLM_MODEL } from '../constants.js';

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
    // XDG_CONFIG_HOME машины разработчика не должен влиять на проверку дефолта.
    const xdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(opencodeAdapter.resolvePath('user')).toMatch(/\.config\/opencode\/opencode\.json$/);
    } finally {
      if (xdg !== undefined) process.env.XDG_CONFIG_HOME = xdg;
      process.env.OPENCODE_CONFIG = configPath;
    }
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

  it('writes models with limit.output matching SSOT caps (8192, DeepSeek 32768)', async () => {
    await opencodeAdapter.apply(input());
    const models = readConfig().provider.joingonka.models;
    expect(models['zai-org/GLM-5.3-Flash'].limit.output).toBe(8192);
    expect(models['MiniMaxAI/MiniMax-M2.7'].limit.output).toBe(8192);
    expect(models[DEEPSEEK_MODEL].limit.output).toBe(32768);
    expect(models['zai-org/GLM-5.3-Flash'].limit.context).toBe(390000);
  });

  it('sets $schema and the coding-agent default model when absent', async () => {
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.model).toBe(OPENCODE_DEFAULT_MODEL);
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

  it('убирает ушедшие модели (Qwen, Kimi) из каталога и сбрасывает наш устаревший дефолт', async () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'joingonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        provider: {
          joingonka: {
            models: {
              'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { name: 'Qwen (old)' },
              'moonshotai/Kimi-K2.6': { name: 'Kimi K2.6 (Gonka)' },
            },
          },
        },
      }),
    );
    await opencodeAdapter.apply(input());
    const cfg = readConfig();
    const models = cfg.provider.joingonka.models;
    expect(models['Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined(); // убрана
    expect(models['moonshotai/Kimi-K2.6']).toBeUndefined(); // ушедшая из сети Kimi — тоже
    expect(models['MiniMaxAI/MiniMax-M2.7']).toBeTruthy();
    expect(models['zai-org/GLM-5.3-Flash']).toBeTruthy(); // актуальная есть
    expect(cfg.model).toBe(OPENCODE_DEFAULT_MODEL); // дефолт на Qwen → сброшен
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

describe('opencodeAdapter.apply — сохранность чужого (0.4.5)', () => {
  it('keeps comments and foreign settings in a JSONC config', async () => {
    writeFileSync(
      configPath,
      `{
  // мой любимый агент
  "agent": { "build": { "model": "anthropic/claude" } },
  "theme": "tokyonight",
}`,
    );

    await opencodeAdapter.apply(input());

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// мой любимый агент');
    expect(raw).toContain('"tokyonight"');
    expect(raw).toContain('"joingonka"');
  });

  it('keeps API keys of other providers in auth.json', async () => {
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: 'api', key: 'sk-other' } }, null, 2),
    );

    await opencodeAdapter.apply(input());

    const auth = readAuth();
    expect(auth.anthropic).toEqual({ type: 'api', key: 'sk-other' });
    expect(auth.joingonka).toEqual({ type: 'api', key: 'jg-test123' });
  });

  it('refuses when auth.json cannot be parsed, leaving both files untouched', async () => {
    writeFileSync(configPath, '{}');
    writeFileSync(authPath, '{ broken');

    await expect(opencodeAdapter.apply(input())).rejects.toThrow(/Nothing was written/);

    expect(readFileSync(authPath, 'utf-8')).toBe('{ broken');
    expect(readFileSync(configPath, 'utf-8')).toBe('{}');
  });

  it('writes an explicit --model as the top-level default', async () => {
    await opencodeAdapter.apply({ ...input({ model: GLM_MODEL }), modelExplicit: true });
    expect(readConfig().model).toBe(`joingonka/${GLM_MODEL}`);
  });

  it('keeps a foreign default model when no model was requested', async () => {
    writeFileSync(configPath, JSON.stringify({ model: 'anthropic/claude-opus-5' }));
    const result = await opencodeAdapter.apply(input());
    expect(readConfig().model).toBe('anthropic/claude-opus-5');
    expect(result.messages.join('\n')).toContain('anthropic/claude-opus-5');
  });
});

describe('opencodeAdapter.apply — ушедшие модели ВНЕ каталога провайдера (0.4.5)', () => {
  // Поля сверены со схемой opencode (packages/core/src/v1/config/*.ts, 21.09.2026):
  // small_model, agent.<имя>.model, mode.<имя>.model (@deprecated), command.<имя>.model.
  const KIMI = 'joingonka/moonshotai/Kimi-K2.6';

  const seedStale = () =>
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          model: 'anthropic/claude-opus-5',
          small_model: KIMI,
          agent: {
            plan: { model: KIMI, prompt: 'plan carefully' },
            build: { model: 'anthropic/claude-opus-5' },
            review: { model: `joingonka/${GLM_MODEL}` },
          },
          mode: { legacy: { model: KIMI } },
          command: { test: { template: 'run tests', model: KIMI } },
        },
        null,
        2,
      ),
    );

  it('replaces our retired model everywhere and keeps foreign and live refs', async () => {
    seedStale();

    const result = await opencodeAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.small_model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(cfg.agent.plan).toEqual({ model: OPENCODE_DEFAULT_MODEL, prompt: 'plan carefully' });
    expect(cfg.mode.legacy.model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(cfg.command.test).toEqual({ template: 'run tests', model: OPENCODE_DEFAULT_MODEL });
    // Чужие и актуальные наши ссылки целы.
    expect(cfg.model).toBe('anthropic/claude-opus-5');
    expect(cfg.agent.build.model).toBe('anthropic/claude-opus-5');
    expect(cfg.agent.review.model).toBe(`joingonka/${GLM_MODEL}`);

    expect(readFileSync(configPath, 'utf-8')).not.toContain('Kimi');
    expect(result.messages.join('\n')).toMatch(/4 references.*no longer served/i);
  });

  it('uses an explicit --model as the replacement', async () => {
    seedStale();

    await opencodeAdapter.apply({ ...input({ model: GLM_MODEL }), modelExplicit: true });

    expect(readConfig().small_model).toBe(`joingonka/${GLM_MODEL}`);
    expect(readConfig().agent.plan.model).toBe(`joingonka/${GLM_MODEL}`);
  });

  it('says nothing about retired models on a clean config', async () => {
    const result = await opencodeAdapter.apply(input());
    expect(result.messages.join('\n')).not.toMatch(/no longer served/i);
  });
});

describe('opencodePaths — где opencode ищет файлы (0.4.5)', () => {
  // opencode берёт каталоги из npm-пакета xdg-basedir (packages/core/src/global.ts):
  // config = <XDG_CONFIG_HOME|~/.config>/opencode, data = <XDG_DATA_HOME|~/.local/share>/opencode.
  const ctx = (env: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, env, home: '/home/u' });

  it('defaults to ~/.config/opencode/opencode.json and ~/.local/share/opencode/auth.json', () => {
    expect(opencodePaths(ctx({}))).toEqual({
      config: '/home/u/.config/opencode/opencode.json',
      auth: '/home/u/.local/share/opencode/auth.json',
    });
  });

  it('honours XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    expect(opencodePaths(ctx({ XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' }))).toEqual({
      config: '/x/cfg/opencode/opencode.json',
      auth: '/x/data/opencode/auth.json',
    });
  });

  it('explicit OPENCODE_CONFIG / OPENCODE_AUTH_JSON win over XDG', () => {
    const paths = opencodePaths(
      ctx({
        XDG_CONFIG_HOME: '/x/cfg',
        XDG_DATA_HOME: '/x/data',
        OPENCODE_CONFIG: '/custom/oc.json',
        OPENCODE_AUTH_JSON: '/custom/auth.json',
      }),
    );
    expect(paths).toEqual({ config: '/custom/oc.json', auth: '/custom/auth.json' });
  });

  it('uses the same home-based layout on Windows (xdg-basedir has no special case)', () => {
    const paths = opencodePaths({ platform: 'win32', env: {}, home: 'C:\\Users\\u' });
    expect(paths.config).toBe('C:\\Users\\u\\.config\\opencode\\opencode.json');
    expect(paths.auth).toBe('C:\\Users\\u\\.local\\share\\opencode\\auth.json');
  });
});

describe('opencodeAdapter.apply — неожиданная форма узла (0.4.5)', () => {
  // Оба итоговых текста (opencode.json и auth.json) считаются ДО первого бэкапа и
  // первой записи: отказ на втором файле не должен оставлять первый уже изменённым.
  const files = () => readdirSync(tmpDir).sort();

  it('refuses when `provider` is not an object: nothing written, no backups', async () => {
    const original = '{ "provider": "anthropic" }';
    writeFileSync(configPath, original);
    writeFileSync(authPath, '{}');

    await expect(opencodeAdapter.apply(input())).rejects.toThrow(
      /opencode\.json.*"provider" is a string.*Nothing was written/s,
    );

    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readFileSync(authPath, 'utf-8')).toBe('{}');
    expect(files()).toEqual(['auth.json', 'opencode.json']);
  });

  it('refuses when our auth.json entry is not an object — and leaves opencode.json alone too', async () => {
    writeFileSync(configPath, '{ "theme": "tokyonight" }');
    const auth = '{ "joingonka": "jg-old-format", "openai": { "type": "api", "key": "sk-x" } }';
    writeFileSync(authPath, auth);

    await expect(opencodeAdapter.apply(input())).rejects.toThrow(
      /auth\.json.*"joingonka" is a string.*Nothing was written/s,
    );

    expect(readFileSync(configPath, 'utf-8')).toBe('{ "theme": "tokyonight" }');
    expect(readFileSync(authPath, 'utf-8')).toBe(auth);
    expect(files()).toEqual(['auth.json', 'opencode.json']);
  });
});
