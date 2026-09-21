/**
 * Тесты адаптера MiniMax Code (`mcode`, https://github.com/MiniMax-AI/minimax-code).
 *
 * Формат сверен с первоисточником 21.09.2026 (mcode 0.5.1: README «Use your own
 * API key (BYOK)», docs/examples.md, packages/config/src/config.ts,
 * local-model-provider-write.ts, service-custom-provider-operations.ts):
 *   ~/.minimax/config.yaml
 *     custom_provider.<key> = { name, kind, enabled, api, options:{apiKey, baseURL,
 *                               authMode}, models:{ "<id>": { name, limit } } }
 *     defaultModel = "custom_provider:<key>/<modelId>"
 *
 * Проверяем:
 * - блок провайдера повторяет то, что пишет сам `mcode provider add`, а `api`
 *   задан ЯВНО (по умолчанию у mcode anthropic-messages — для нашего /v1 неверно);
 * - лимиты моделей реальные (без них mcode берёт 200000/16384 для любой модели);
 * - ключ ЛИТЕРАЛОМ, файл 0o600 (mcode сам отказывается грузить «открытый» конфиг);
 * - чужие провайдеры, чужие корневые ключи, чужие поля нашего блока, КОММЕНТАРИИ;
 * - битый YAML / корень-не-map → отказ без записи и без утечки фрагмента файла;
 * - модель по умолчанию: правило п.5 + парные ключи (контекст/эффорт прошлой
 *   модели снимаются при смене — так делает и сам mcode);
 * - каталог данных: MINIMAX_DATA_DIR, запасной MAVIS_DATA_DIR;
 * - идемпотентность повторного apply (байт-в-байт).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { minimaxCodeAdapter, minimaxCodeConfigPath } from './minimax-code.js';
import {
  CODING_AGENT_DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  DEFAULT_MODEL,
  GLM_MODEL,
} from '../constants.js';

const ENV_KEYS = ['HOME', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR'];

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-mcode-test-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (overrides: Partial<{ model: string; modelExplicit: boolean }> = {}) => ({
  apiKey: 'jg-test123',
  model: CODING_AGENT_DEFAULT_MODEL,
  scope: 'user' as const,
  ...overrides,
});

const dataDir = () => join(tmpDir, '.minimax');
const configPath = () => join(dataDir(), 'config.yaml');
const readConfig = (path = configPath()) => parse(readFileSync(path, 'utf-8')) as Record<string, any>;

const seed = (text: string) => {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configPath(), text);
};

const backups = () =>
  existsSync(dataDir()) ? readdirSync(dataDir()).filter((f) => f.startsWith('config.yaml.bak.')) : [];

const ref = (model: string) => `custom_provider:joingonka/${model}`;

describe('minimaxCodeAdapter — shape', () => {
  it('is a YAML-writing OpenAI-mode adapter with the coding-agent default model', () => {
    expect(minimaxCodeAdapter.id).toBe('minimax-code');
    expect(minimaxCodeAdapter.format).toBe('yaml');
    expect(minimaxCodeAdapter.apiMode).toBe('openai');
    expect(minimaxCodeAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(minimaxCodeAdapter.supportsLocalScope).toBeFalsy();
    expect(minimaxCodeAdapter.label).toMatch(/MiniMax Code/);
  });
});

describe('minimaxCodeAdapter.resolvePath', () => {
  it('defaults to ~/.minimax/config.yaml', () => {
    expect(minimaxCodeAdapter.resolvePath('user')).toBe(configPath());
  });

  it('honours MINIMAX_DATA_DIR (каталог данных)', () => {
    process.env.MINIMAX_DATA_DIR = join(tmpDir, 'profile-a');
    expect(minimaxCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'profile-a', 'config.yaml'));
  });

  it('falls back to MAVIS_DATA_DIR, and MINIMAX_DATA_DIR wins over it', () => {
    process.env.MAVIS_DATA_DIR = join(tmpDir, 'mavis');
    expect(minimaxCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'mavis', 'config.yaml'));

    process.env.MINIMAX_DATA_DIR = join(tmpDir, 'minimax');
    expect(minimaxCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'minimax', 'config.yaml'));
  });

  it('ignores a blank MINIMAX_DATA_DIR (mcode тоже требует непустое значение)', () => {
    process.env.MINIMAX_DATA_DIR = '   ';
    process.env.MAVIS_DATA_DIR = join(tmpDir, 'mavis');
    expect(minimaxCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'mavis', 'config.yaml'));
  });
});

describe('minimaxCodeAdapter.apply — provider block (custom_provider.joingonka)', () => {
  it('writes the same fields as `mcode provider add`, with the api format EXPLICIT', async () => {
    const result = await minimaxCodeAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(configPath());

    const provider = readConfig().custom_provider.joingonka;
    expect(provider.name).toBe('JoinGonka');
    expect(provider.kind).toBe('custom');
    expect(provider.enabled).toBe(true);
    // ⚠ Без явного api mcode берёт anthropic-messages и пойдёт на /v1/v1/messages.
    expect(provider.api).toBe('openai-completions');
    expect(provider.options.baseURL).toBe('https://gate.joingonka.ai/v1');
    expect(provider.options.apiKey).toBe('jg-test123');
    expect(provider.options.authMode).toBe('api-key');
  });

  it('writes models keyed by id with REAL context and output limits', async () => {
    await minimaxCodeAdapter.apply(input());
    const models = readConfig().custom_provider.joingonka.models;

    expect(Object.keys(models).sort()).toEqual([DEEPSEEK_MODEL, DEFAULT_MODEL, GLM_MODEL].sort());
    expect(models[DEFAULT_MODEL].limit).toEqual({ context: 200000, output: 8192 });
    expect(models[DEEPSEEK_MODEL].limit).toEqual({ context: 380000, output: 32768 });
    expect(models[GLM_MODEL].limit).toEqual({ context: 390000, output: 8192 });
    expect(models[DEEPSEEK_MODEL].name).toBe('DeepSeek V4 Flash (Gonka)');
    expect(models[DEEPSEEK_MODEL].reasoning).toBe(true);
    expect(models[GLM_MODEL].reasoning).toBe(true);
    expect(models[DEFAULT_MODEL].reasoning).toBeUndefined();
  });

  it('writes only model fields known to mcode ModelConfig', async () => {
    await minimaxCodeAdapter.apply(input());
    const models = readConfig().custom_provider.joingonka.models as Record<string, object>;
    for (const model of Object.values(models)) {
      for (const key of Object.keys(model)) expect(['name', 'reasoning', 'limit']).toContain(key);
    }
  });

  it('убирает посеянную устаревшую модель (Kimi K2.6) и старый ключ', async () => {
    seed(
      [
        'custom_provider:',
        '  joingonka:',
        '    api: openai-completions',
        '    options:',
        '      apiKey: jg-old',
        '      baseURL: https://old.example.com/v1',
        '    models:',
        '      moonshotai/Kimi-K2.6:',
        '        limit:',
        '          context: 262144',
      ].join('\n') + '\n',
    );

    await minimaxCodeAdapter.apply(input());

    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw).not.toContain('Kimi');
    expect(raw).not.toContain('jg-old');
    expect(raw).not.toContain('old.example.com');
  });

  it('re-enables our provider if it was switched off', async () => {
    seed('custom_provider:\n  joingonka:\n    enabled: false\n');
    await minimaxCodeAdapter.apply(input());
    expect(readConfig().custom_provider.joingonka.enabled).toBe(true);
  });
});

describe('minimaxCodeAdapter.apply — secret safety', () => {
  it('writes the literal key, never an env reference', async () => {
    await minimaxCodeAdapter.apply(input());
    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw).toContain('jg-test123');
    expect(raw).not.toContain('${');
    expect(raw).not.toContain('MCODE_PROVIDER_API_KEY');
  });

  it('does not instruct an env export', async () => {
    const result = await minimaxCodeAdapter.apply(input());
    const joined = result.messages.join('\n');
    expect(joined).not.toMatch(/export\s+\w+=/);
    expect(joined).toContain('0o600');
  });

  it.runIf(platform() !== 'win32')('writes config.yaml with 0o600, tightening an open file', async () => {
    seed('logLevel: info\n');
    await minimaxCodeAdapter.apply(input());
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

describe('minimaxCodeAdapter.apply — сохранность чужого', () => {
  it('preserves foreign providers, root keys, fields inside our block and COMMENTS', async () => {
    seed(
      [
        '# мой конфиг mcode',
        'logLevel: debug',
        'permissionMode: ask # не трогать',
        'minimax_api:',
        '  apiKey: sk-minimax-own',
        'provider:',
        '  minimax:',
        '    options:',
        '      authMode: managed-login',
        'custom_provider:',
        '  my-relay:',
        '    options:',
        '      apiKey: sk-relay-key',
        '      baseURL: https://relay.example.com',
        '    models:',
        '      MiniMax-M2: {}',
        '  joingonka:',
        '    options:',
        '      headers:',
        '        X-Team: platform',
        '      timeout: 600000',
      ].join('\n') + '\n',
    );

    await minimaxCodeAdapter.apply(input());

    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw).toContain('# мой конфиг mcode');
    expect(raw).toContain('# не трогать');

    const cfg = readConfig();
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.permissionMode).toBe('ask');
    expect(cfg.minimax_api.apiKey).toBe('sk-minimax-own');
    expect(cfg.provider.minimax.options.authMode).toBe('managed-login');
    expect(cfg.custom_provider['my-relay'].options.apiKey).toBe('sk-relay-key');
    expect(cfg.custom_provider['my-relay'].models).toEqual({ 'MiniMax-M2': {} });
    // чужие поля ВНУТРИ нашего блока (заголовки, таймаут) — выбор пользователя
    expect(cfg.custom_provider.joingonka.options.headers).toEqual({ 'X-Team': 'platform' });
    expect(cfg.custom_provider.joingonka.options.timeout).toBe(600000);
    expect(cfg.custom_provider.joingonka.options.apiKey).toBe('jg-test123');
  });

  it('does not re-fold long user strings', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    seed(`note: ${long}\n`);
    await minimaxCodeAdapter.apply(input());
    expect(readFileSync(configPath(), 'utf-8')).toContain(`note: ${long}\n`);
  });

  it('replaces garbage at custom_provider.joingonka (наш ключ) with a proper block', async () => {
    seed('custom_provider:\n  joingonka: oops\n  other:\n    api: openai-completions\n');
    await minimaxCodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.custom_provider.joingonka.api).toBe('openai-completions');
    expect(cfg.custom_provider.other.api).toBe('openai-completions');
  });

  it('treats an empty `custom_provider:` key as absent', async () => {
    seed('custom_provider:\nlogLevel: info\n');
    await minimaxCodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.custom_provider.joingonka.kind).toBe('custom');
    expect(cfg.logLevel).toBe('info');
  });
});

describe('minimaxCodeAdapter.apply — отказ без записи', () => {
  it('refuses on broken YAML: no write, no backup, no leaked file fragment', async () => {
    const broken = 'custom_provider:\n  my-relay: [unclosed\n  apiKey: sk-foreign-secret\n';
    seed(broken);

    const error = await minimaxCodeAdapter.apply(input()).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Nothing was written/);
    expect((error as Error).message).not.toContain('sk-foreign-secret');
    expect(readFileSync(configPath(), 'utf-8')).toBe(broken);
    expect(backups()).toEqual([]);
  });

  it('refuses when the root is not a mapping', async () => {
    seed('- just\n- a list\n');
    await expect(minimaxCodeAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath(), 'utf-8')).toBe('- just\n- a list\n');
    expect(backups()).toEqual([]);
  });

  it('refuses when `custom_provider` is not a mapping', async () => {
    seed('custom_provider:\n  - a\n  - b\n');
    await expect(minimaxCodeAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(configPath(), 'utf-8')).toBe('custom_provider:\n  - a\n  - b\n');
  });
});

describe('minimaxCodeAdapter.apply — модель по умолчанию (defaultModel)', () => {
  it('sets defaultModel to custom_provider:<key>/<model> on a fresh install', async () => {
    const result = await minimaxCodeAdapter.apply(input());
    expect(readConfig().defaultModel).toBe(ref(DEEPSEEK_MODEL));
    expect(result.messages.join('\n')).toContain(ref(DEEPSEEK_MODEL));
  });

  it('keeps a FOREIGN default and its paired keys without --model', async () => {
    seed(
      [
        'defaultModel: minimax/MiniMax-M3',
        'defaultModelVariant: thinking',
        'defaultModelContextWindow: 512000',
        'defaultModelThinking:',
        '  effort: high',
      ].join('\n') + '\n',
    );

    const result = await minimaxCodeAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.defaultModel).toBe('minimax/MiniMax-M3');
    expect(cfg.defaultModelVariant).toBe('thinking');
    expect(cfg.defaultModelContextWindow).toBe(512000);
    expect(cfg.defaultModelThinking).toEqual({ effort: 'high' });
    expect(result.messages.join('\n')).toContain('minimax/MiniMax-M3');
  });

  it('writes an EXPLICIT model and drops the paired keys of the previous default', async () => {
    // Контекст 512000 от MiniMax-M3, применённый к нашей модели (390000), дал бы
    // переполнение окна. Сам mcode при смене defaultModel снимает те же ключи.
    seed(
      [
        'defaultModel: minimax/MiniMax-M3',
        'defaultModelVariant: thinking',
        'defaultModelContextWindow: 512000',
        'defaultModelThinking:',
        '  effort: high',
        'logLevel: info',
      ].join('\n') + '\n',
    );

    await minimaxCodeAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));

    const cfg = readConfig();
    expect(cfg.defaultModel).toBe(ref(GLM_MODEL));
    expect(cfg.defaultModelVariant).toBeUndefined();
    expect(cfg.defaultModelContextWindow).toBeUndefined();
    expect(cfg.defaultModelThinking).toBeUndefined();
    expect(cfg.logLevel).toBe('info');
  });

  it('keeps OUR current model and its paired keys without --model', async () => {
    seed(`defaultModel: ${ref(GLM_MODEL)}\ndefaultModelThinking:\n  effort: low\n`);
    await minimaxCodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.defaultModel).toBe(ref(GLM_MODEL));
    expect(cfg.defaultModelThinking).toEqual({ effort: 'low' });
  });

  it('keeps our current model written with a #variant suffix', async () => {
    seed(`defaultModel: "${ref(GLM_MODEL)}#thinking"\n`);
    await minimaxCodeAdapter.apply(input());
    expect(readConfig().defaultModel).toBe(`${ref(GLM_MODEL)}#thinking`);
  });

  it('keeps the paired keys when the explicit model is already the default', async () => {
    seed(`defaultModel: ${ref(GLM_MODEL)}\ndefaultModelThinking:\n  effort: low\n`);
    await minimaxCodeAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));
    expect(readConfig().defaultModelThinking).toEqual({ effort: 'low' });
  });

  it('replaces OUR stale model (Kimi K2.6 ушла из сети)', async () => {
    seed(`defaultModel: ${ref('moonshotai/Kimi-K2.6')}\ndefaultModelContextWindow: 262144\n`);
    await minimaxCodeAdapter.apply(input());
    const cfg = readConfig();
    expect(cfg.defaultModel).toBe(ref(DEEPSEEK_MODEL));
    expect(cfg.defaultModelContextWindow).toBeUndefined();
  });
});

describe('minimaxCodeAdapter.apply — наша убранная модель в defaultLightModel', () => {
  it('replaces OUR stale light model and reports it', async () => {
    seed(`defaultModel: minimax/MiniMax-M3\ndefaultLightModel: ${ref('moonshotai/Kimi-K2.6')}\n`);

    const result = await minimaxCodeAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.defaultLightModel).toBe(ref(DEEPSEEK_MODEL));
    expect(cfg.defaultModel).toBe('minimax/MiniMax-M3'); // чужой дефолт цел
    expect(result.messages.join('\n')).toContain('Cleaned up 1 reference');
  });

  it('keeps a foreign or current light model and stays silent', async () => {
    seed(`defaultLightModel: minimax/MiniMax-M2.7\n`);
    const foreign = await minimaxCodeAdapter.apply(input());
    expect(readConfig().defaultLightModel).toBe('minimax/MiniMax-M2.7');
    expect(foreign.messages.join('\n')).not.toContain('Cleaned up');

    seed(`defaultLightModel: ${ref(DEFAULT_MODEL)}\n`);
    await minimaxCodeAdapter.apply(input());
    expect(readConfig().defaultLightModel).toBe(ref(DEFAULT_MODEL));
  });

  it('counts a stale default together with the light model', async () => {
    seed(`defaultModel: ${ref('moonshotai/Kimi-K2.6')}\ndefaultLightModel: ${ref('moonshotai/Kimi-K2.6')}\n`);
    const result = await minimaxCodeAdapter.apply(input());
    expect(result.messages.join('\n')).toContain('Cleaned up 2 references');
  });
});

describe('minimaxCodeAdapter.apply — backups, idempotency, data dir', () => {
  it('backs up an existing config and reports no backup for a new one', async () => {
    const fresh = await minimaxCodeAdapter.apply(input());
    expect(fresh.backupPath).toBeNull();

    const again = await minimaxCodeAdapter.apply(input());
    expect(again.backupPath).not.toBeNull();
    expect(backups().length).toBe(1);
  });

  it('is byte-identical on a second apply', async () => {
    seed('# мой конфиг\nlogLevel: debug\ncustom_provider:\n  my-relay:\n    api: openai-completions\n');
    await minimaxCodeAdapter.apply(input());
    const first = readFileSync(configPath(), 'utf-8');
    await minimaxCodeAdapter.apply(input());
    expect(readFileSync(configPath(), 'utf-8')).toBe(first);
  });

  it('writes into MINIMAX_DATA_DIR when it is set', async () => {
    const custom = join(tmpDir, 'profile-a');
    process.env.MINIMAX_DATA_DIR = custom;

    const result = await minimaxCodeAdapter.apply(input());

    expect(result.configPath).toBe(join(custom, 'config.yaml'));
    expect(readConfig(join(custom, 'config.yaml')).custom_provider.joingonka.kind).toBe('custom');
    expect(existsSync(dataDir())).toBe(false);
  });
});

describe('minimaxCodeConfigPath — чужая платформа через PathContext (0.5.0)', () => {
  // Сверено 21.09.2026 по packages/config/src/data-dir.ts и config.ts (main ae65651d):
  // каталог данных — path.join(os.homedir(), '.minimax') на ВСЕХ платформах, особого
  // случая для Windows нет; MINIMAX_DATA_DIR / MAVIS_DATA_DIR берутся как есть (trim).
  const win = (env: NodeJS.ProcessEnv) => ({ platform: 'win32' as const, env, home: 'C:\\Users\\u' });

  it('uses <home>\\.minimax\\config.yaml on Windows — no AppData special case', () => {
    expect(minimaxCodeConfigPath(win({}))).toBe('C:\\Users\\u\\.minimax\\config.yaml');
    expect(minimaxCodeConfigPath(win({ APPDATA: 'C:\\AD' }))).toBe('C:\\Users\\u\\.minimax\\config.yaml');
  });

  it('honours MINIMAX_DATA_DIR, then MAVIS_DATA_DIR, with Windows separators', () => {
    expect(minimaxCodeConfigPath(win({ MINIMAX_DATA_DIR: ' D:\\mm ' }))).toBe('D:\\mm\\config.yaml');
    expect(minimaxCodeConfigPath(win({ MAVIS_DATA_DIR: 'D:\\mavis' }))).toBe('D:\\mavis\\config.yaml');
    expect(minimaxCodeConfigPath(win({ MINIMAX_DATA_DIR: 'D:\\mm', MAVIS_DATA_DIR: 'D:\\mavis' }))).toBe(
      'D:\\mm\\config.yaml',
    );
    // Пустая переменная — как отсутствие.
    expect(minimaxCodeConfigPath(win({ MINIMAX_DATA_DIR: '  ' }))).toBe('C:\\Users\\u\\.minimax\\config.yaml');
  });

  it('keeps the POSIX layout unchanged', () => {
    expect(minimaxCodeConfigPath({ platform: 'linux', env: {}, home: '/home/u' })).toBe(
      '/home/u/.minimax/config.yaml',
    );
    expect(minimaxCodeConfigPath({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe(
      '/Users/u/.minimax/config.yaml',
    );
  });
});
