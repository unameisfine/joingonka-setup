/**
 * Контракт-тесты адаптера Kimi Code CLI (~/.kimi-code/config.toml).
 *
 * Изоляция — подменой HOME и настоящей переменной инструмента KIMI_CODE_HOME.
 *
 * Проверяем: пути, формат файла (golden), ключ ЛИТЕРАЛОМ в таблице провайдера,
 * записи моделей с реальными лимитами, сохранность чужих таблиц и КОММЕНТАРИЕВ,
 * правила дефолтной модели, чистку ушедшей модели вместе со ссылками из
 * [secondary_model] (иначе Kimi Code не стартует), отказ без записи и без
 * бэкапа, права 0o600, идемпотентность байт-в-байт.
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
  chmodSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from 'smol-toml';
import { kimiCodeAdapter, kimiCodeConfigPath } from './kimi-code.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

const ENV_KEYS = ['HOME', 'KIMI_CODE_HOME'] as const;
const GATE = 'https://gate.joingonka.ai/v1';
const alias = (model: string): string => `joingonka/${model}`;
const DEFAULT_ALIAS = alias(CODING_AGENT_DEFAULT_MODEL);

let tmpDir: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-kimi-'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  configPath = join(tmpDir, '.kimi-code', 'config.toml');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: CODING_AGENT_DEFAULT_MODEL, scope: 'user' as const };

function seed(text: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
}
const readText = (): string => readFileSync(configPath, 'utf-8');
const readConfig = (): any => parse(readText());
const backups = (): string[] =>
  existsSync(dirname(configPath))
    ? readdirSync(dirname(configPath)).filter((name) => name.includes('.bak.'))
    : [];

/** Таблица модели в том виде, в каком её пишет установщик. */
function modelBlock(model: string, context: number, output: number, caps: string, name: string): string[] {
  return [
    `[models."${alias(model)}"]`,
    'provider = "joingonka"',
    `model = "${model}"`,
    `max_context_size = ${context}`,
    `max_output_size = ${output}`,
    `capabilities = ${caps}`,
    `display_name = "${name}"`,
  ];
}

const OUR_MODELS = [
  ...modelBlock(DEFAULT_MODEL, 180000, 8192, '["tool_use"]', 'MiniMax M2.7 (Gonka)'),
  '',
  ...modelBlock(
    'deepseek-ai/DeepSeek-V4-Flash-0731',
    380000,
    32768,
    '["thinking", "tool_use"]',
    'DeepSeek V4 Flash (Gonka)',
  ),
  '',
  ...modelBlock(GLM_MODEL, 390000, 8192, '["thinking", "tool_use"]', 'GLM 5.3 Flash (Gonka)'),
  '',
];

const OUR_PROVIDER = [
  '[providers.joingonka]',
  'type = "openai"',
  `base_url = "${GATE}"`,
  'api_key = "jg-test123"',
  '',
];

describe('kimiCodeAdapter — метаданные', () => {
  it('is a writing TOML adapter for a coding agent', () => {
    expect(kimiCodeAdapter.id).toBe('kimi-code');
    expect(kimiCodeAdapter.format).toBe('toml');
    expect(kimiCodeAdapter.apiMode).toBe('openai');
    expect(kimiCodeAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    // У Kimi Code один пользовательский конфиг, проектного нет.
    expect(kimiCodeAdapter.supportsLocalScope).toBeFalsy();
    expect(kimiCodeAdapter.wantsPricing).toBeFalsy();
  });
});

describe('kimiCodeAdapter.resolvePath', () => {
  it('defaults to ~/.kimi-code/config.toml (not the archived ~/.kimi of the Python CLI)', () => {
    expect(kimiCodeAdapter.resolvePath('user')).toBe(configPath);
    expect(kimiCodeAdapter.resolvePath('local')).toBe(configPath);
  });

  it('honours KIMI_CODE_HOME (the data root of the tool)', () => {
    process.env.KIMI_CODE_HOME = join(tmpDir, 'sandbox');
    expect(kimiCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'sandbox', 'config.toml'));
  });

  it('uses %USERPROFILE%\\.kimi-code on Windows', () => {
    expect(kimiCodeConfigPath({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\.kimi-code\\config.toml',
    );
  });
});

describe('kimiCodeAdapter.apply — чистая установка', () => {
  it('writes exactly the documented provider, models and default (golden)', async () => {
    const result = await kimiCodeAdapter.apply(input);
    expect(readText()).toBe(
      [`default_model = "${DEFAULT_ALIAS}"`, '', ...OUR_PROVIDER, ...OUR_MODELS].join('\n'),
    );
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBeNull();
  });

  it('stores the API key literally — Kimi Code never reads provider keys from the shell', async () => {
    const result = await kimiCodeAdapter.apply(input);
    const provider = readConfig().providers.joingonka;
    expect(provider).toEqual({ type: 'openai', base_url: GATE, api_key: 'jg-test123' });
    const text = result.messages.join('\n');
    expect(text).toContain('api_key');
    expect(text).not.toContain('jg-test123'); // значение ключа в сообщениях не повторяем
    expect(text).not.toMatch(/export /);
  });

  it('declares every model with real limits; every alias resolves to our provider', async () => {
    await kimiCodeAdapter.apply(input);
    const { models, providers, default_model } = readConfig();
    expect(Object.keys(models)).toEqual([
      alias(DEFAULT_MODEL),
      alias('deepseek-ai/DeepSeek-V4-Flash-0731'),
      alias(GLM_MODEL),
    ]);
    for (const [name, entry] of Object.entries<any>(models)) {
      expect(providers).toHaveProperty(entry.provider); // «must be defined in providers»
      expect(name).toBe(alias(entry.model));
    }
    expect(models).toHaveProperty(default_model); // «must be defined in models»
    expect(models[alias(DEFAULT_MODEL)].capabilities).toEqual(['tool_use']);
    expect(models[alias(GLM_MODEL)].max_context_size).toBe(390000);
    expect(models[alias(GLM_MODEL)].max_output_size).toBe(8192);
  });

  it.skipIf(platform() === 'win32')('writes the file 0o600 and creates the data dir 0o700', async () => {
    await kimiCodeAdapter.apply(input);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(platform() === 'win32')('tightens an existing wider file', async () => {
    seed('telemetry = false\n');
    chmodSync(configPath, 0o644);
    await kimiCodeAdapter.apply(input);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run leaves the file byte-identical', async () => {
    await kimiCodeAdapter.apply(input);
    const first = readText();
    const second = await kimiCodeAdapter.apply(input);
    expect(readText()).toBe(first);
    expect(second.backupPath).toMatch(/config\.toml\.bak\./);
  });
});

describe('kimiCodeAdapter.apply — чужой конфиг', () => {
  // Сокращённый «Complete example» из документации инструмента + комментарии.
  const FOREIGN = [
    '# Kimi Code — правлено руками',
    'default_model = "kimi-code/k3"   # основной',
    'default_permission_mode = "manual"',
    'telemetry = false',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding/v1"',
    'api_key = ""',
    '',
    '# главный рабочий алиас',
    '[models."kimi-code/k3"]',
    'provider = "managed:kimi-code"',
    'model = "k3"',
    'max_context_size = 1048576',
    'capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]',
    'support_efforts = [ "low", "high", "max" ]',
    '',
    '[thinking]',
    'enabled = true',
    "effort = 'high'  # не трогать",
    '',
    '[[permission.rules]]',
    'decision = "deny"',
    'pattern = "Bash(rm -rf*)"',
    '',
    '[[hooks]]',
    'event = "PreToolUse"',
    'command = "node ~/.kimi-code/hooks/check-bash.mjs"',
    '',
  ].join('\n');

  it('appends our provider and models; every foreign line and comment stays byte-identical', async () => {
    seed(FOREIGN);
    await kimiCodeAdapter.apply(input);
    const text = readText();
    expect(text.startsWith(FOREIGN)).toBe(true);
    expect(text.slice(FOREIGN.length)).toBe(['', ...OUR_PROVIDER, ...OUR_MODELS].join('\n'));
  });

  it('keeps a foreign default model and tells how to pick ours', async () => {
    seed(FOREIGN);
    const result = await kimiCodeAdapter.apply(input);
    expect(readConfig().default_model).toBe('kimi-code/k3');
    const text = result.messages.join('\n');
    expect(text).toContain('kimi-code/k3');
    expect(text).toContain(`kimi -m "${DEFAULT_ALIAS}"`);
    expect(text).toContain('/model');
  });

  it('writes an explicit --model over a foreign default and says how to go back', async () => {
    seed(FOREIGN);
    const result = await kimiCodeAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    expect(readConfig().default_model).toBe(alias(GLM_MODEL));
    expect(readText()).toContain(`default_model = "${alias(GLM_MODEL)}"   # основной`);
    const text = result.messages.join('\n');
    expect(text).toContain('kimi-code/k3'); // что было
    expect(text).toMatch(/config\.toml\.bak\./); // как вернуть
  });

  it('declares an explicit model that is outside the catalog, with conservative limits', async () => {
    await kimiCodeAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const config = readConfig();
    expect(config.default_model).toBe(alias('vendor/brand-new'));
    expect(config.models[alias('vendor/brand-new')]).toEqual({
      provider: 'joingonka',
      model: 'vendor/brand-new',
      max_context_size: 180000,
      max_output_size: 8192,
      capabilities: ['tool_use'],
      display_name: 'vendor/brand-new',
    });
  });
});

describe('kimiCodeAdapter.apply — наш прежний конфиг', () => {
  const KIMI_ALIAS = alias('moonshotai/Kimi-K2.6');
  const RETIRED = [
    `default_model = "${KIMI_ALIAS}"`,
    '',
    '[providers.joingonka]',
    'type = "openai"',
    `base_url = "${GATE}"`,
    'api_key = "jg-old"',
    '',
    '# старая модель',
    `[models."${KIMI_ALIAS}"]`,
    'provider = "joingonka"',
    'model = "moonshotai/Kimi-K2.6"',
    'max_context_size = 262144',
    '',
    `[models."${KIMI_ALIAS}".overrides]`,
    'display_name = "Kimi via Gonka"',
    '',
  ];

  it('removes our retired model (seeded Kimi K2.6) and resets the default', async () => {
    seed(RETIRED.join('\n'));
    const result = await kimiCodeAdapter.apply(input);
    const config = readConfig();
    expect(config.default_model).toBe(DEFAULT_ALIAS);
    expect(config.models).not.toHaveProperty(KIMI_ALIAS);
    expect(config.providers.joingonka.api_key).toBe('jg-test123');
    expect(Object.keys(config.models)).toHaveLength(3);
    expect(readText()).toContain('# старая модель'); // комментарии не удаляем никогда
    expect(result.messages.join('\n')).toMatch(/no longer served/);

    const once = readText();
    await kimiCodeAdapter.apply(input);
    expect(readText()).toBe(once);
  });

  it('repoints [secondary_model] — a dangling alias there stops Kimi Code from starting', async () => {
    seed(
      [
        ...RETIRED,
        '[secondary_model]',
        `default_model = "${KIMI_ALIAS}"   # сабагенты`,
        '',
        '[secondary_model.models]',
        `"${KIMI_ALIAS}" = "cheap one"`,
        `"${alias(DEFAULT_MODEL)}" = "workhorse"`,
        '',
      ].join('\n'),
    );
    await kimiCodeAdapter.apply(input);
    const { secondary_model: secondary, models } = readConfig();
    expect(secondary.default_model).toBe(DEFAULT_ALIAS);
    // default_model пула обязан быть одним из его ключей, а каждый ключ — записью [models].
    expect(Object.keys(secondary.models).sort()).toEqual([alias(DEFAULT_MODEL), DEFAULT_ALIAS].sort());
    for (const name of Object.keys(secondary.models)) expect(models).toHaveProperty(name);
    expect(secondary.models[alias(DEFAULT_MODEL)]).toBe('workhorse');
    expect(readText()).toContain('# сабагенты');
  });

  it('repoints a forced secondary model that has no pool', async () => {
    seed([...RETIRED, '[secondary_model]', `default_model = "${KIMI_ALIAS}"`, 'force = true', ''].join('\n'));
    await kimiCodeAdapter.apply(input);
    expect(readConfig().secondary_model).toEqual({ default_model: DEFAULT_ALIAS, force: true });
  });

  it('keeps our own still-served model chosen by the user', async () => {
    seed(`default_model = "${alias(DEFAULT_MODEL)}"\n`);
    const result = await kimiCodeAdapter.apply(input);
    expect(readConfig().default_model).toBe(alias(DEFAULT_MODEL));
    expect(result.messages.join('\n')).toContain(alias(DEFAULT_MODEL));
    expect(result.messages.join('\n')).not.toMatch(/go back/i);
  });

  it('keeps a user-made variant of a live model and the overrides of our aliases', async () => {
    seed(
      [
        'default_model = "ds-low"',
        '',
        '[models.ds-low]',
        'provider = "joingonka"',
        'model = "deepseek-ai/DeepSeek-V4-Flash-0731"',
        'max_context_size = 380000',
        'support_efforts = ["low", "high"]',
        '',
        `[models."${DEFAULT_ALIAS}".overrides]`,
        'max_context_size = 131072   # сжимать раньше',
        '',
      ].join('\n'),
    );
    await kimiCodeAdapter.apply(input);
    const config = readConfig();
    expect(config.default_model).toBe('ds-low'); // наша живая модель — выбор пользователя
    expect(config.models['ds-low'].support_efforts).toEqual(['low', 'high']);
    expect(config.models[DEFAULT_ALIAS].overrides).toEqual({ max_context_size: 131072 });
    expect(config.models[DEFAULT_ALIAS].max_context_size).toBe(380000);
    expect(readText()).toContain('max_context_size = 131072   # сжимать раньше');
  });

  it('keeps the user keys of our provider table', async () => {
    seed(
      [
        '[providers.joingonka]',
        'type = "openai_responses"',
        'api_key = "jg-old"   # прежний',
        '',
        '[providers.joingonka.custom_headers]',
        'X-Team = "core"',
        '',
      ].join('\n'),
    );
    await kimiCodeAdapter.apply(input);
    const provider = readConfig().providers.joingonka;
    expect(provider.type).toBe('openai');
    expect(provider.custom_headers).toEqual({ 'X-Team': 'core' });
    expect(readText()).toContain('api_key = "jg-test123"   # прежний');
  });

  it('removes api_key_env — Kimi Code rejects a provider that sets both', async () => {
    seed(`[providers.joingonka]\ntype = "openai"\nbase_url = "${GATE}"\napi_key_env = "JOINGONKA_API_KEY"\n`);
    const result = await kimiCodeAdapter.apply(input);
    const provider = readConfig().providers.joingonka;
    expect(provider).not.toHaveProperty('api_key_env');
    expect(provider.api_key).toBe('jg-test123');
    expect(result.messages.join('\n')).toContain('api_key_env');
  });
});

describe('kimiCodeAdapter.apply — отказ без записи', () => {
  async function expectRefusal(seeded: string, pattern: RegExp): Promise<void> {
    seed(seeded);
    await expect(kimiCodeAdapter.apply(input)).rejects.toThrow(pattern);
    await expect(kimiCodeAdapter.apply(input)).rejects.toThrow(configPath);
    await expect(kimiCodeAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readText()).toBe(seeded); // файл не тронут
    expect(backups()).toEqual([]); // и бэкап не создан
  }

  it('refuses a broken TOML file', async () => {
    await expectRefusal('default_model = "kimi-code/k3"\n[providers.kimi\ntype = "kimi"\n', /not valid TOML/);
  });

  it('refuses our provider written as an inline table', async () => {
    await expectRefusal(
      `[providers]\njoingonka = { type = "openai", base_url = "${GATE}" }\n`,
      /providers\.joingonka/,
    );
  });

  it('refuses our provider written with dotted keys', async () => {
    await expectRefusal('providers.joingonka.type = "openai"\n', /providers\.joingonka/);
  });

  it('refuses an OAuth reference on our provider — it conflicts with api_key', async () => {
    await expectRefusal(
      '[providers.joingonka]\ntype = "openai"\n\n[providers.joingonka.oauth]\nstorage = "file"\nkey = "k"\n',
      /oauth/,
    );
  });

  it('refuses a models section that is not a table', async () => {
    await expectRefusal('models = "oops"\n', /"models".*expected to be a table/s);
  });
});
