/**
 * Контракт-тесты адаптера Crush (Charm) — пользовательский crush.json.
 *
 * Изоляция — настоящими переменными инструмента CRUSH_GLOBAL_CONFIG и
 * CRUSH_GLOBAL_DATA (обе — каталоги).
 *
 * Проверяем: пути (в том числе Windows и XDG), блок провайдера `openai-compat`
 * с ключом литералом и полным набором полей модели, цены (живые и фолбэк),
 * правила `models.large`/`models.small`; файл состояния Crush (выбор из его
 * интерфейса перекрывает crush.json): без --model не трогаем и ЧЕСТНО говорим,
 * какая модель действует, при явном --model правим точечно `models.large` и
 * сообщаем, что и где изменено; сохранность чужого, отказ без записи и без
 * бэкапа, права 0o600, идемпотентность.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { crushAdapter, crushPaths } from './crush.js';
import {
  CODING_AGENT_DEFAULT_MODEL,
  DEFAULT_MODEL,
  GLM_MODEL,
  OPENCLAW_MODELS,
  openclawModelEntry,
} from '../constants.js';

const ENV_KEYS = [
  'HOME',
  'CRUSH_GLOBAL_CONFIG',
  'CRUSH_GLOBAL_DATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;
const GATE = 'https://gate.joingonka.ai/v1';

let tmpDir: string;
let configPath: string;
let statePath: string;
let crushrcPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-crush-'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  process.env.CRUSH_GLOBAL_CONFIG = join(tmpDir, 'cfg');
  process.env.CRUSH_GLOBAL_DATA = join(tmpDir, 'data');
  configPath = join(tmpDir, 'cfg', 'crush.json');
  crushrcPath = join(tmpDir, 'cfg', 'crushrc');
  statePath = join(tmpDir, 'data', 'crush.json');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: CODING_AGENT_DEFAULT_MODEL, scope: 'user' as const };
const OURS = (model: string) => ({ model, provider: 'joingonka' });

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const readConfig = (): any => parseJsonc(readFileSync(configPath, 'utf-8'));
const readText = (): string => readFileSync(configPath, 'utf-8');
const backups = (dir = dirname(configPath)): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name.includes('.bak.')) : [];

describe('crushAdapter — метаданные', () => {
  it('is a writing JSON adapter for a coding agent that wants live prices', () => {
    expect(crushAdapter.id).toBe('crush');
    expect(crushAdapter.format).toBe('json');
    expect(crushAdapter.apiMode).toBe('openai');
    expect(crushAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(crushAdapter.wantsPricing).toBe(true);
    expect(crushAdapter.supportsLocalScope).toBeFalsy();
  });
});

describe('crushAdapter — пути', () => {
  it('honours CRUSH_GLOBAL_CONFIG / CRUSH_GLOBAL_DATA (directories)', () => {
    expect(crushAdapter.resolvePath('user')).toBe(configPath);
    expect(crushPaths().state).toBe(statePath);
    expect(crushPaths().crushrc).toBe(crushrcPath);
  });

  it('defaults to ~/.config/crush and ~/.local/share/crush', () => {
    const paths = crushPaths({ platform: 'linux', env: {}, home: '/home/me' });
    expect(paths.config).toBe('/home/me/.config/crush/crush.json');
    expect(paths.state).toBe('/home/me/.local/share/crush/crush.json');
  });

  it('honours XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    const paths = crushPaths({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' },
      home: '/home/me',
    });
    expect(paths.config).toBe('/x/cfg/crush/crush.json');
    expect(paths.state).toBe('/x/data/crush/crush.json');
  });

  it('on Windows keeps config in %USERPROFILE%\\.config and state in %LOCALAPPDATA%', () => {
    const paths = crushPaths({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'C:\\Users\\me',
    });
    expect(paths.config).toBe('C:\\Users\\me\\.config\\crush\\crush.json');
    expect(paths.state).toBe('C:\\Users\\me\\AppData\\Local\\crush\\crush.json');
  });
});

describe('crushAdapter.apply — блок провайдера', () => {
  it('writes an openai-compat provider with a literal key', async () => {
    const result = await crushAdapter.apply(input);
    const p = readConfig().providers.joingonka;
    expect(p.type).toBe('openai-compat');
    expect(p.base_url).toBe(GATE);
    expect(p.api_key).toBe('jg-test123'); // литерал, не $VAR
    expect(p.name).toBe('JoinGonka (Gonka)');
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBeNull();
  });

  it('describes every model with all schema-required fields and real limits', async () => {
    await crushAdapter.apply(input);
    const models = readConfig().providers.joingonka.models;
    expect(models.map((m: any) => m.id)).toEqual(OPENCLAW_MODELS.map((m) => m.id));

    const deepseek = models.find((m: any) => m.id === 'deepseek-ai/DeepSeek-V4-Flash-0731');
    expect(deepseek.name).toBe('DeepSeek V4 Flash (Gonka)');
    expect(deepseek.context_window).toBe(380000);
    expect(deepseek.default_max_tokens).toBe(32768);
    expect(deepseek.can_reason).toBe(true);
    expect(deepseek.supports_attachments).toBe(false);

    const minimax = models.find((m: any) => m.id === DEFAULT_MODEL);
    expect(minimax.context_window).toBe(200000);
    expect(minimax.default_max_tokens).toBe(8192);
    expect(minimax.can_reason).toBe(false);
    // Без reasoning_levels Crush не добавляет в запрос reasoning_effort.
    expect(minimax).not.toHaveProperty('reasoning_levels');
  });

  it('falls back to the reference price from constants when no live price is given', async () => {
    await crushAdapter.apply(input);
    const model = readConfig().providers.joingonka.models[0];
    const cost = openclawModelEntry(OPENCLAW_MODELS[0]!).cost as Record<string, number>;
    expect(model.cost_per_1m_in).toBe(cost.input);
    expect(model.cost_per_1m_out).toBe(cost.output);
    expect(model.cost_per_1m_in_cached).toBe(cost.cacheWrite); // --price-cache-create
    expect(model.cost_per_1m_out_cached).toBe(cost.cacheRead); // --price-cache-hit
  });

  it('uses live prices when the orchestrator provides them', async () => {
    await crushAdapter.apply({ ...input, pricing: { input: 0.005808, output: 0.017424 } });
    const model = readConfig().providers.joingonka.models[0];
    expect(model.cost_per_1m_in).toBe(0.005808);
    expect(model.cost_per_1m_out).toBe(0.017424);
  });

  it('stamps $schema only when it is absent', async () => {
    await crushAdapter.apply(input);
    expect(readConfig().$schema).toBe('https://charm.land/crush.json');

    seed(configPath, JSON.stringify({ $schema: 'https://example.com/own.json' }));
    await crushAdapter.apply(input);
    expect(readConfig().$schema).toBe('https://example.com/own.json');
  });

  it('writes STRICT JSON — Crush rejects comments and trailing commas', async () => {
    await crushAdapter.apply(input);
    expect(() => JSON.parse(readText())).not.toThrow();
  });

  it.skipIf(platform() === 'win32')('writes the file with mode 0o600', async () => {
    await crushAdapter.apply(input);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('keeps foreign providers and user-added fields of our own block', async () => {
    seed(
      configPath,
      JSON.stringify({
        providers: {
          anthropic: { api_key: '$ANTHROPIC_API_KEY' },
          joingonka: { api_key: 'jg-old', extra_headers: { 'X-Team': 'platform' } },
        },
        options: { tui: { compact_mode: true } },
      }),
    );
    await crushAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.providers.anthropic).toEqual({ api_key: '$ANTHROPIC_API_KEY' });
    expect(cfg.providers.joingonka.extra_headers).toEqual({ 'X-Team': 'platform' });
    expect(cfg.providers.joingonka.api_key).toBe('jg-test123');
    expect(cfg.options.tui.compact_mode).toBe(true);
  });

  it('re-enables our provider if it was disabled, and says so', async () => {
    seed(configPath, JSON.stringify({ providers: { joingonka: { disable: true } } }));
    const result = await crushAdapter.apply(input);
    expect(readConfig().providers.joingonka).not.toHaveProperty('disable');
    expect(result.messages.join('\n')).toMatch(/disable/);
  });

  it('is idempotent: a second run leaves the file byte-identical', async () => {
    await crushAdapter.apply(input);
    const first = readText();
    const second = await crushAdapter.apply(input);
    expect(readText()).toBe(first);
    expect(second.backupPath).toMatch(/crush\.json\.bak\./);
  });
});

describe('crushAdapter.apply — модели large и small', () => {
  it('sets large to the coding-agent default and small to the roomiest model', async () => {
    const result = await crushAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.models.large).toEqual(OURS(CODING_AGENT_DEFAULT_MODEL));
    expect(cfg.models.small).toEqual(OURS(DEFAULT_MODEL));
    expect(result.messages.join('\n')).toContain(`joingonka/${CODING_AGENT_DEFAULT_MODEL}`);
  });

  it('keeps a foreign large model and does not hijack the small one', async () => {
    const foreign = { model: 'claude-sonnet-4-20250514', provider: 'anthropic', think: true };
    seed(configPath, JSON.stringify({ models: { large: foreign } }));
    const result = await crushAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.models.large).toEqual(foreign);
    expect(cfg.models.small).toBeUndefined();
    expect(result.messages.join('\n')).toContain('anthropic/claude-sonnet-4-20250514');
  });

  it('keeps our own still-served large model chosen by the user', async () => {
    seed(configPath, JSON.stringify({ models: { large: OURS(DEFAULT_MODEL) } }));
    await crushAdapter.apply(input);
    expect(readConfig().models.large).toEqual(OURS(DEFAULT_MODEL));
  });

  it('resets retired models of ours (Kimi) in both slots and drops them from the catalog', async () => {
    seed(
      configPath,
      JSON.stringify({
        providers: { joingonka: { models: [{ id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6 (Gonka)' }] } },
        models: {
          large: { ...OURS('moonshotai/Kimi-K2.6'), max_tokens: 64000 },
          small: OURS('moonshotai/Kimi-K2.6'),
        },
      }),
    );
    await crushAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.providers.joingonka.models.map((m: any) => m.id)).not.toContain('moonshotai/Kimi-K2.6');
    // Запись заменяется целиком: max_tokens подбирался под ушедшую модель.
    expect(cfg.models.large).toEqual(OURS(CODING_AGENT_DEFAULT_MODEL));
    expect(cfg.models.small).toEqual(OURS(DEFAULT_MODEL));
  });

  it('writes an explicit --model as large even over a foreign one', async () => {
    seed(configPath, JSON.stringify({ models: { large: { model: 'gpt-5.6', provider: 'openai' } } }));
    await crushAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    expect(readConfig().models.large).toEqual(OURS(GLM_MODEL));
  });

  it('adds an explicit model that is outside the catalog, with conservative limits', async () => {
    await crushAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const cfg = readConfig();
    const extra = cfg.providers.joingonka.models.find((m: any) => m.id === 'vendor/brand-new');
    expect(extra.context_window).toBe(200000);
    expect(extra.default_max_tokens).toBe(8192);
    expect(cfg.models.large).toEqual(OURS('vendor/brand-new'));
  });
});

describe('crushAdapter.apply — файл состояния и crushrc перекрывают crush.json', () => {
  const STATE = JSON.stringify(
    {
      models: { large: { model: 'claude-opus-5', provider: 'anthropic', max_tokens: 32000 } },
      recent_models: { large: [{ model: 'claude-opus-5', provider: 'anthropic' }] },
    },
    null,
    2,
  );
  const explicit = { ...input, model: GLM_MODEL, modelExplicit: true };
  const readState = (): any => JSON.parse(readFileSync(statePath, 'utf-8'));

  describe('без --model: чужой выбор из интерфейса не трогаем', () => {
    it('leaves the state file byte-identical and says which model really stays active', async () => {
      seed(statePath, STATE);
      const result = await crushAdapter.apply(input);

      expect(readFileSync(statePath, 'utf-8')).toBe(STATE);
      expect(backups(dirname(statePath))).toEqual([]);
      expect(readConfig().models.large).toEqual(OURS(CODING_AGENT_DEFAULT_MODEL));

      const text = result.messages.join('\n');
      expect(text).toContain('anthropic/claude-opus-5');
      expect(text).toContain(statePath);
      expect(text).toContain('ctrl+l');
    });

    it('stays quiet when the UI selection already is the model we configured', async () => {
      seed(statePath, JSON.stringify({ models: { large: OURS(CODING_AGENT_DEFAULT_MODEL) } }));
      const result = await crushAdapter.apply(input);
      expect(result.messages.join('\n')).not.toContain('ctrl+l');
    });

    it('ignores an unreadable state file instead of failing the install', async () => {
      seed(statePath, '{ broken');
      await expect(crushAdapter.apply(input)).resolves.toMatchObject({ wrote: true });
      expect(readFileSync(statePath, 'utf-8')).toBe('{ broken');
    });

    it('mentions a crushrc that pins the large model and does not create a state file', async () => {
      seed(crushrcPath, '# мой конфиг\nprovider add ollama --type ollama\n  model large ollama/llama3.3 --think\n');
      const result = await crushAdapter.apply(input);
      const text = result.messages.join('\n');
      expect(text).toContain('ollama/llama3.3');
      expect(text).toContain(crushrcPath);
      expect(readFileSync(crushrcPath, 'utf-8')).toContain('model large ollama/llama3.3');
      expect(existsSync(statePath)).toBe(false);
    });
  });

  describe('явный --model: обязан стать дефолтом, поэтому правим и файл состояния', () => {
    it('replaces only models.large there, backs the file up and says what was changed', async () => {
      seed(statePath, STATE);
      const result = await crushAdapter.apply(explicit);

      const state = readState();
      // Запись заменяется целиком — как делает сам Crush: max_tokens был под прежнюю модель.
      expect(state.models.large).toEqual(OURS(GLM_MODEL));
      expect(state.recent_models).toEqual({ large: [{ model: 'claude-opus-5', provider: 'anthropic' }] });
      expect(backups(dirname(statePath))).toHaveLength(1);
      expect(readConfig().models.large).toEqual(OURS(GLM_MODEL));

      const text = result.messages.join('\n');
      expect(text).toContain(statePath);
      expect(text).toContain('models.large');
      expect(text).toContain('anthropic/claude-opus-5'); // что было
      expect(text).toContain(`joingonka/${GLM_MODEL}`); // что стало
      expect(text).toMatch(/backed up at .*crush\.json\.bak\./);
    });

    it.skipIf(platform() === 'win32')('keeps the state file owner-only, like Crush itself', async () => {
      seed(statePath, STATE);
      await crushAdapter.apply(explicit);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
    });

    it('does not touch a state file that already selects the requested model', async () => {
      const same = JSON.stringify({ models: { large: { ...OURS(GLM_MODEL), max_tokens: 4096 } } });
      seed(statePath, same);
      const result = await crushAdapter.apply(explicit);
      expect(readFileSync(statePath, 'utf-8')).toBe(same);
      expect(backups(dirname(statePath))).toEqual([]);
      expect(result.messages.join('\n')).not.toContain(statePath);
    });

    it('does not create a state file when nothing would override crush.json', async () => {
      await crushAdapter.apply(explicit);
      expect(existsSync(statePath)).toBe(false);
    });

    it('leaves a state file without a model selection alone', async () => {
      const noChoice = JSON.stringify({ options: { tui: { compact_mode: true } } });
      seed(statePath, noChoice);
      await crushAdapter.apply(explicit);
      expect(readFileSync(statePath, 'utf-8')).toBe(noChoice);
    });

    it('outranks a model pinned in crushrc by writing the state file (state beats crushrc)', async () => {
      seed(crushrcPath, 'model large ollama/llama3.3\n');
      const result = await crushAdapter.apply(explicit);

      expect(readState().models.large).toEqual(OURS(GLM_MODEL));
      expect(readFileSync(crushrcPath, 'utf-8')).toBe('model large ollama/llama3.3\n'); // Bash не правим
      const text = result.messages.join('\n');
      expect(text).toContain(crushrcPath);
      expect(text).toContain('ollama/llama3.3');
      expect(text).toContain(statePath);
    });

    it('refuses when the state file cannot be parsed — and then writes NOTHING anywhere', async () => {
      seed(configPath, '{}');
      seed(statePath, '{ broken');
      await expect(crushAdapter.apply(explicit)).rejects.toThrow(/Nothing was written/);
      expect(readText()).toBe('{}');
      expect(readFileSync(statePath, 'utf-8')).toBe('{ broken');
      expect(backups()).toEqual([]);
      expect(backups(dirname(statePath))).toEqual([]);
    });

    it('refuses when "models" in the state file is not an object', async () => {
      seed(statePath, '{ "models": [] }');
      await expect(crushAdapter.apply(explicit)).rejects.toThrow(/Nothing was written/);
      expect(existsSync(configPath)).toBe(false);
      expect(readFileSync(statePath, 'utf-8')).toBe('{ "models": [] }');
    });
  });

  it('warns that Crush needs strict JSON when the file has comments — and keeps them', async () => {
    seed(configPath, '{\n  // мои провайдеры\n  "providers": {}\n}\n');
    const result = await crushAdapter.apply(input);
    expect(readText()).toContain('// мои провайдеры');
    expect(result.messages.join('\n')).toMatch(/strict JSON/);
  });
});

describe('crushAdapter.apply — отказ без записи', () => {
  const refuses = async (text: string) => {
    seed(configPath, text);
    await expect(crushAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readText()).toBe(text);
    expect(backups()).toEqual([]);
  };

  it('refuses an unparsable crush.json', () => refuses('{ "providers": '));
  it('refuses when "providers" is not an object', () => refuses('{ "providers": [] }'));
  it('refuses when "models" is not an object', () => refuses('{ "models": "large" }'));

  it('refuses a key that Crush would shell-expand', async () => {
    await expect(crushAdapter.apply({ ...input, apiKey: 'jg-$(whoami)' })).rejects.toThrow(
      /Nothing was written/,
    );
    expect(existsSync(configPath)).toBe(false);
  });
});
