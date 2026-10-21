/**
 * Контракт-тесты адаптера MiMo Code (форк OpenCode, два файла: конфиг + auth.json).
 *
 * Изоляция — настоящей переменной инструмента MIMOCODE_HOME (каталог с
 * подкаталогами config/ и data/), а не выдуманными env установщика.
 *
 * Проверяем: пути и их переопределения, блок провайдера БЕЗ ключа, ключ в
 * нативном auth.json, права 0o600, сохранность чужих провайдеров, чужих ключей
 * и КОММЕНТАРИЕВ, отказ на битом файле без записи и без бэкапа, явную модель,
 * чистку посеянной устаревшей модели (Kimi), идемпотентность.
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
import { mimoCodeAdapter, mimoCodePaths } from './mimo-code.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

const ENV_KEYS = ['HOME', 'MIMOCODE_HOME', 'MIMOCODE_CONFIG', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;

let tmpDir: string;
let mimoHome: string;
let configPath: string;
let authPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-mimo-'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  mimoHome = join(tmpDir, 'mimo-home');
  process.env.MIMOCODE_HOME = mimoHome;
  configPath = join(mimoHome, 'config', 'mimocode.jsonc');
  authPath = join(mimoHome, 'data', 'auth.json');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: CODING_AGENT_DEFAULT_MODEL, scope: 'user' as const };
const OUR_DEFAULT = `joingonka/${CODING_AGENT_DEFAULT_MODEL}`;

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const readConfig = (path = configPath): any => parseJsonc(readFileSync(path, 'utf-8'));
const readAuth = (): any => JSON.parse(readFileSync(authPath, 'utf-8'));
const backupsIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name.includes('.bak.')) : [];

describe('mimoCodeAdapter — метаданные', () => {
  it('is a writing JSON adapter for a coding agent', () => {
    expect(mimoCodeAdapter.id).toBe('mimo-code');
    expect(mimoCodeAdapter.format).toBe('json');
    expect(mimoCodeAdapter.apiMode).toBe('openai');
    expect(mimoCodeAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(mimoCodeAdapter.supportsLocalScope).toBeFalsy();
  });
});

describe('mimoCodeAdapter.resolvePath', () => {
  it('uses MIMOCODE_HOME/config/mimocode.jsonc', () => {
    expect(mimoCodeAdapter.resolvePath('user')).toBe(configPath);
  });

  it('defaults to ~/.config/mimocode/mimocode.jsonc', () => {
    delete process.env.MIMOCODE_HOME;
    expect(mimoCodeAdapter.resolvePath('user')).toBe(
      join(tmpDir, '.config', 'mimocode', 'mimocode.jsonc'),
    );
  });

  it('honours XDG_CONFIG_HOME', () => {
    delete process.env.MIMOCODE_HOME;
    process.env.XDG_CONFIG_HOME = join(tmpDir, 'xdg');
    expect(mimoCodeAdapter.resolvePath('user')).toBe(
      join(tmpDir, 'xdg', 'mimocode', 'mimocode.jsonc'),
    );
  });

  it('honours MIMOCODE_CONFIG (extra config layer of the tool)', () => {
    process.env.MIMOCODE_CONFIG = join(tmpDir, 'custom.jsonc');
    expect(mimoCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'custom.jsonc'));
  });

  it('picks an existing mimocode.json instead of creating a second config', () => {
    const jsonPath = join(mimoHome, 'config', 'mimocode.json');
    seed(jsonPath, '{}');
    expect(mimoCodeAdapter.resolvePath('user')).toBe(jsonPath);
  });

  it('rejects a relative MIMOCODE_HOME the same way the tool does', () => {
    process.env.MIMOCODE_HOME = 'relative/dir';
    expect(() => mimoCodeAdapter.resolvePath('user')).toThrow(/absolute path/);
  });

  it('uses ~/.config and ~/.local/share on Windows too (xdg-basedir has no special case)', () => {
    const paths = mimoCodePaths({ platform: 'win32', env: {}, home: 'C:\\Users\\me' });
    expect(paths.config).toBe('C:\\Users\\me\\.config\\mimocode\\mimocode.jsonc');
    expect(paths.auth).toBe('C:\\Users\\me\\.local\\share\\mimocode\\auth.json');
  });
});

describe('mimoCodeAdapter.apply — блок провайдера', () => {
  it('writes provider.joingonka with @ai-sdk/openai-compatible and baseURL WITH /v1', async () => {
    const result = await mimoCodeAdapter.apply(input);
    const p = readConfig().provider.joingonka;
    expect(p.npm).toBe('@ai-sdk/openai-compatible');
    expect(p.options.baseURL).toBe('https://gate.joingonka.ai/v1');
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(configPath);
  });

  it('keeps the API key OUT of the config (it lives in auth.json)', async () => {
    await mimoCodeAdapter.apply(input);
    expect(readConfig().provider.joingonka.options.apiKey).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).not.toContain('jg-test123');
  });

  it('writes the catalog with real limits, tool_call and reasoning flags', async () => {
    await mimoCodeAdapter.apply(input);
    const models = readConfig().provider.joingonka.models;
    expect(models['MiniMaxAI/MiniMax-M2.7'].limit).toEqual({ context: 180000, output: 8192 });
    expect(models['deepseek-ai/DeepSeek-V4-Flash-0731'].limit).toEqual({
      context: 380000,
      output: 32768,
    });
    expect(models['zai-org/GLM-5.3-Flash'].limit).toEqual({ context: 390000, output: 8192 });
    expect(models['zai-org/GLM-5.3-Flash'].tool_call).toBe(true);
    expect(models['zai-org/GLM-5.3-Flash'].reasoning).toBe(true);
    expect(models['MiniMaxAI/MiniMax-M2.7'].reasoning).toBeUndefined();
  });

  it('stamps the MiMo $schema when absent and replaces the opencode one (as the tool does)', async () => {
    await mimoCodeAdapter.apply(input);
    expect(readConfig().$schema).toBe('https://mimo.xiaomi.com/mimocode/config.json');

    seed(configPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json' }));
    await mimoCodeAdapter.apply(input);
    expect(readConfig().$schema).toBe('https://mimo.xiaomi.com/mimocode/config.json');
  });

  it('leaves a custom $schema alone', async () => {
    seed(configPath, JSON.stringify({ $schema: 'https://example.com/my.json' }));
    await mimoCodeAdapter.apply(input);
    expect(readConfig().$schema).toBe('https://example.com/my.json');
  });
});

describe('mimoCodeAdapter.apply — хранилище ключей auth.json', () => {
  it('stores the key as { type: "api", key } under the same provider id', async () => {
    await mimoCodeAdapter.apply(input);
    expect(readAuth().joingonka).toEqual({ type: 'api', key: 'jg-test123' });
    expect(readConfig().provider.joingonka).toBeTruthy();
  });

  it('keeps credentials of other providers', async () => {
    seed(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-other' } }, null, 2));
    await mimoCodeAdapter.apply(input);
    const auth = readAuth();
    expect(auth.anthropic).toEqual({ type: 'api', key: 'sk-other' });
    expect(auth.joingonka).toEqual({ type: 'api', key: 'jg-test123' });
  });

  it('replaces a previous non-API credential of ours as a whole', async () => {
    seed(authPath, JSON.stringify({ joingonka: 'garbage' }));
    await mimoCodeAdapter.apply(input);
    expect(readAuth().joingonka).toEqual({ type: 'api', key: 'jg-test123' });
  });

  it.skipIf(platform() === 'win32')('writes both files with mode 0o600', async () => {
    await mimoCodeAdapter.apply(input);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it('removes a stale options.apiKey of ours so it cannot shadow auth.json', async () => {
    seed(
      configPath,
      JSON.stringify({ provider: { joingonka: { options: { apiKey: 'jg-old', timeout: 1000 } } } }),
    );
    const result = await mimoCodeAdapter.apply(input);
    const options = readConfig().provider.joingonka.options;
    expect(options.apiKey).toBeUndefined();
    expect(options.timeout).toBe(1000); // чужая настройка в нашем блоке цела
    expect(result.messages.join('\n')).toMatch(/options\.apiKey/);
  });
});

describe('mimoCodeAdapter.apply — модель по умолчанию', () => {
  it('sets the coding-agent default when no model is configured', async () => {
    const result = await mimoCodeAdapter.apply(input);
    expect(readConfig().model).toBe(OUR_DEFAULT);
    expect(result.messages.join('\n')).toContain(OUR_DEFAULT);
  });

  it('keeps a foreign default model and says so', async () => {
    seed(configPath, JSON.stringify({ model: 'anthropic/claude-opus-5' }));
    const result = await mimoCodeAdapter.apply(input);
    expect(readConfig().model).toBe('anthropic/claude-opus-5');
    expect(result.messages.join('\n')).toContain('anthropic/claude-opus-5');
  });

  it('keeps our own still-served model chosen by the user', async () => {
    seed(configPath, JSON.stringify({ model: `joingonka/${DEFAULT_MODEL}` }));
    await mimoCodeAdapter.apply(input);
    expect(readConfig().model).toBe(`joingonka/${DEFAULT_MODEL}`);
  });

  it('resets a retired default (Kimi) and drops retired models from the catalog', async () => {
    seed(
      configPath,
      JSON.stringify({
        model: 'joingonka/moonshotai/Kimi-K2.6',
        provider: {
          joingonka: { models: { 'moonshotai/Kimi-K2.6': { name: 'Kimi K2.6 (Gonka)' } } },
        },
      }),
    );
    await mimoCodeAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.provider.joingonka.models['moonshotai/Kimi-K2.6']).toBeUndefined();
    expect(cfg.provider.joingonka.models['zai-org/GLM-5.3-Flash']).toBeTruthy();
    expect(cfg.model).toBe(OUR_DEFAULT);
  });

  it('repoints retired references outside the catalog (small_model, agent models)', async () => {
    seed(
      configPath,
      JSON.stringify({
        model: 'anthropic/claude-opus-5',
        small_model: 'joingonka/moonshotai/Kimi-K2.6',
        agent: {
          plan: { model: 'joingonka/moonshotai/Kimi-K2.6' },
          build: { model: 'anthropic/claude-opus-5' },
        },
      }),
    );
    const result = await mimoCodeAdapter.apply(input);
    const cfg = readConfig();
    expect(cfg.small_model).toBe(OUR_DEFAULT);
    expect(cfg.agent.plan.model).toBe(OUR_DEFAULT);
    expect(cfg.agent.build.model).toBe('anthropic/claude-opus-5'); // чужое не трогаем
    expect(cfg.model).toBe('anthropic/claude-opus-5');
    expect(result.messages.join('\n')).toMatch(/Cleaned up 2 references/);
  });

  it('writes an explicit --model as the default even over a foreign one', async () => {
    seed(configPath, JSON.stringify({ model: 'anthropic/claude-opus-5' }));
    await mimoCodeAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    expect(readConfig().model).toBe(`joingonka/${GLM_MODEL}`);
  });

  it('adds an explicit model that is outside the catalog, with conservative limits', async () => {
    await mimoCodeAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const cfg = readConfig();
    expect(cfg.model).toBe('joingonka/vendor/brand-new');
    expect(cfg.provider.joingonka.models['vendor/brand-new'].limit).toEqual({
      context: 180000,
      output: 8192,
    });
  });

  it('respects a default model set in a lower-priority global config file', async () => {
    // Инструмент сливает config.json → mimocode.json → mimocode.jsonc: модель из
    // нижнего файла действует, пока верхний её не задаёт. Запись своей модели в
    // верхний файл молча перебила бы выбор пользователя.
    seed(configPath, '{}');
    seed(join(mimoHome, 'config', 'mimocode.json'), JSON.stringify({ model: 'openai/gpt-5.6' }));
    const result = await mimoCodeAdapter.apply(input);
    expect(readConfig().model).toBeUndefined();
    expect(result.messages.join('\n')).toContain('openai/gpt-5.6');
  });
});

describe('mimoCodeAdapter.apply — сохранность чужого', () => {
  it('keeps comments, trailing commas and foreign providers', async () => {
    seed(
      configPath,
      `{
  // не трогать: мой локальный провайдер
  "provider": { "ollama": { "npm": "ollama-ai-provider", }, },
  "theme": "tokyonight", // любимая тема
}`,
    );
    await mimoCodeAdapter.apply(input);
    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// не трогать: мой локальный провайдер');
    expect(raw).toContain('// любимая тема');
    expect(readConfig().provider.ollama.npm).toBe('ollama-ai-provider');
    expect(readConfig().provider.joingonka).toBeTruthy();
  });

  it('adds our provider to enabled_providers when the user restricts the list', async () => {
    seed(configPath, JSON.stringify({ enabled_providers: ['anthropic'] }));
    await mimoCodeAdapter.apply(input);
    expect(readConfig().enabled_providers).toEqual(['anthropic', 'joingonka']);
    await mimoCodeAdapter.apply(input);
    expect(readConfig().enabled_providers).toEqual(['anthropic', 'joingonka']); // без дублей
  });

  it('warns instead of editing when the user disabled our provider', async () => {
    seed(configPath, JSON.stringify({ disabled_providers: ['joingonka'] }));
    const result = await mimoCodeAdapter.apply(input);
    expect(readConfig().disabled_providers).toEqual(['joingonka']);
    expect(result.messages.join('\n')).toMatch(/disabled_providers/);
  });

  it('backs up existing files and reports no backup for new ones', async () => {
    const first = await mimoCodeAdapter.apply(input);
    expect(first.backupPath).toBeNull();
    const second = await mimoCodeAdapter.apply(input);
    expect(second.backupPath).toMatch(/mimocode\.jsonc\.bak\./);
    expect(backupsIn(dirname(authPath))).toHaveLength(1);
  });

  it('is idempotent: a second run leaves both files byte-identical', async () => {
    await mimoCodeAdapter.apply(input);
    const config1 = readFileSync(configPath, 'utf-8');
    const auth1 = readFileSync(authPath, 'utf-8');
    await mimoCodeAdapter.apply(input);
    expect(readFileSync(configPath, 'utf-8')).toBe(config1);
    expect(readFileSync(authPath, 'utf-8')).toBe(auth1);
  });
});

describe('mimoCodeAdapter.apply — отказ без записи', () => {
  it('refuses an unparsable config: nothing written, no backup, no auth.json', async () => {
    seed(configPath, '{ "provider": ');
    await expect(mimoCodeAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ "provider": ');
    expect(backupsIn(dirname(configPath))).toEqual([]);
    expect(existsSync(authPath)).toBe(false);
  });

  it('refuses an unparsable auth.json and leaves the config untouched', async () => {
    seed(configPath, '{}');
    seed(authPath, '{ broken');
    await expect(mimoCodeAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{}');
    expect(readFileSync(authPath, 'utf-8')).toBe('{ broken');
    expect(backupsIn(dirname(configPath))).toEqual([]);
    expect(backupsIn(dirname(authPath))).toEqual([]);
  });

  it('refuses a config whose "provider" is not an object, without a stray backup', async () => {
    seed(configPath, '{ "provider": "oops" }');
    await expect(mimoCodeAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ "provider": "oops" }');
    expect(backupsIn(dirname(configPath))).toEqual([]);
    expect(existsSync(authPath)).toBe(false);
  });
});
