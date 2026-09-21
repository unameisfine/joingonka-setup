/** Контракт-тесты Kilo-адаптера (OpenCode-формат + tool_call/reasoning). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiloAdapter, kiloConfigPath } from './kilo.js';
import { KILO_DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

// HOME и XDG_CONFIG_HOME тоже в песочнице: адаптер смотрит на ВСЕ глобальные
// файлы Kilo (в том числе чтобы привести в порядок свой прежний блок в файле ниже
// по приоритету) — настоящий ~/.config/kilo разработчика тесты видеть не должны.
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'KILO_CONFIG'] as const;

let tmpDir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-kilo-'));
  configPath = join(tmpDir, 'kilo.jsonc');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = join(tmpDir, 'home');
  process.env.KILO_CONFIG = configPath;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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

describe('kiloAdapter — какой глобальный файл читает Kilo (0.5.0)', () => {
  // ★ Kilo сливает ПЯТЬ глобальных файлов по возрастанию приоритета (config.ts,
  // loadGlobal; сверено 21.09.2026): config.json → kilo.json → kilo.jsonc →
  // opencode.json → opencode.jsonc. До 0.5.0 установщик всегда писал kilo.jsonc:
  // рядом с рабочим kilo.json заводил второй конфиг, а `model` из opencode.json(c)
  // в том же каталоге молча перекрывала наш `--model`.
  const KIMI = 'joingonka/moonshotai/Kimi-K2.6';
  let globalDir: string;
  const file = (name: string) => join(globalDir, name);
  const seed = (name: string, value: unknown) =>
    writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const read = (name: string): any =>
    JSON.parse(readFileSync(file(name), 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
  const backupsOf = (name: string) =>
    readdirSync(globalDir).filter((f) => f.startsWith(`${name}.bak.`));

  beforeEach(() => {
    // Без KILO_CONFIG адаптер работает с настоящей раскладкой каталога
    // (HOME — в песочнице, см. общий beforeEach).
    delete process.env.KILO_CONFIG;
    globalDir = join(process.env.HOME!, '.config', 'kilo');
    mkdirSync(globalDir, { recursive: true });
  });

  it('creates kilo.jsonc — the file Kilo seeds itself — when there is no global config yet', async () => {
    const result = await kiloAdapter.apply(input);
    expect(result.configPath).toBe(file('kilo.jsonc'));
    expect(readdirSync(globalDir)).toEqual(['kilo.jsonc']);
  });

  it('writes into an existing kilo.json instead of starting a second config next to it', async () => {
    seed('kilo.json', { theme: 'dark' });

    const result = await kiloAdapter.apply(input);

    expect(result.configPath).toBe(file('kilo.json'));
    expect(kiloAdapter.resolvePath('user')).toBe(file('kilo.json'));
    expect(read('kilo.json').theme).toBe('dark');
    expect(read('kilo.json').provider.joingonka.options.apiKey).toBe('jg-test123');
    expect(readdirSync(globalDir).filter((f) => !f.includes('.bak.'))).toEqual(['kilo.json']);
  });

  it('makes an explicit --model effective when opencode.jsonc in the same directory pins another', async () => {
    seed('kilo.jsonc', { model: KILO_DEFAULT_MODEL });
    seed('opencode.jsonc', '{\n  // перенёс из opencode\n  "model": "anthropic/claude-opus-5"\n}\n');

    const result = await kiloAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });

    // opencode.jsonc Kilo грузит ПОСЛЕДНИМ — значит, действует значение оттуда.
    expect(result.configPath).toBe(file('opencode.jsonc'));
    expect(read('opencode.jsonc').model).toBe(`joingonka/${GLM_MODEL}`);
    expect(readFileSync(file('opencode.jsonc'), 'utf-8')).toContain('// перенёс из opencode');
  });

  it("respects the user's model from a lower-priority file", async () => {
    seed('kilo.jsonc', { $schema: 'https://app.kilo.ai/config.json' });
    seed('config.json', { model: 'anthropic/claude-opus-5' });

    const result = await kiloAdapter.apply(input);

    expect(read('kilo.jsonc').model).toBeUndefined();
    expect(result.messages.join('\n')).toContain('Default model: anthropic/claude-opus-5');
    expect(read('config.json')).toEqual({ model: 'anthropic/claude-opus-5' });
    expect(backupsOf('config.json')).toHaveLength(0);
  });

  it('refreshes the provider block an earlier installer left in a lower-priority file', async () => {
    seed('opencode.json', { theme: 'light' });
    seed('kilo.jsonc', {
      model: KIMI,
      small_model: KIMI,
      provider: {
        joingonka: {
          options: { baseURL: 'https://gate.joingonka.ai/v1', apiKey: 'jg-old-key', timeout: 600000 },
          models: { 'moonshotai/Kimi-K2.6': { name: 'Kimi K2.6 (Gonka)' } },
        },
      },
    });

    const result = await kiloAdapter.apply(input);

    // Целевой — opencode.json (выше kilo.jsonc по приоритету загрузки).
    expect(result.configPath).toBe(file('opencode.json'));
    expect(read('opencode.json').theme).toBe('light');
    expect(read('opencode.json').model).toBe(KILO_DEFAULT_MODEL);

    // Прежний блок приведён в порядок на месте: каталог, ключ, ссылки.
    const lower = read('kilo.jsonc');
    expect(Object.keys(lower.provider.joingonka.models)).not.toContain('moonshotai/Kimi-K2.6');
    expect(lower.provider.joingonka.models[GLM_MODEL]).toBeTruthy();
    expect(lower.provider.joingonka.options.apiKey).toBe('jg-test123');
    expect(lower.provider.joingonka.options.timeout).toBe(600000);
    expect(lower.model).toBe(KILO_DEFAULT_MODEL);
    expect(lower.small_model).toBe(KILO_DEFAULT_MODEL);
    expect(readFileSync(file('kilo.jsonc'), 'utf-8')).not.toContain('jg-old-key');
    expect(backupsOf('kilo.jsonc')).toHaveLength(1);

    const text = result.messages.join('\n');
    expect(text).toContain(file('kilo.jsonc'));
    expect(text).toMatch(/2 references.*no longer served/i);
  });

  it('is idempotent across both files', async () => {
    seed('opencode.json', { theme: 'light' });
    seed('kilo.jsonc', { provider: { joingonka: { models: { 'moonshotai/Kimi-K2.6': {} } } } });

    await kiloAdapter.apply(input);
    const first = [readFileSync(file('opencode.json'), 'utf-8'), readFileSync(file('kilo.jsonc'), 'utf-8')];
    await kiloAdapter.apply(input);

    expect(readFileSync(file('opencode.json'), 'utf-8')).toBe(first[0]);
    expect(readFileSync(file('kilo.jsonc'), 'utf-8')).toBe(first[1]);
    expect(backupsOf('kilo.jsonc')).toHaveLength(1);
  });

  it('keeps every file that holds the API key owner-only, the refreshed lower one included', async () => {
    seed('opencode.json', { theme: 'light' });
    seed('kilo.jsonc', { provider: { joingonka: { options: { apiKey: 'jg-old-key' } } } });

    await kiloAdapter.apply(input);

    for (const name of ['opencode.json', 'kilo.jsonc']) {
      expect(statSync(file(name)).mode & 0o777, name).toBe(0o600);
    }
  });

  it('leaves an unparsable lower-priority file alone and says so', async () => {
    seed('kilo.jsonc', { $schema: 'https://app.kilo.ai/config.json' });
    seed('config.json', '{ broken');

    const result = await kiloAdapter.apply(input);

    expect(readFileSync(file('config.json'), 'utf-8')).toBe('{ broken');
    expect(result.messages.join('\n')).toMatch(/config\.json.*could not be parsed/);
  });
});
