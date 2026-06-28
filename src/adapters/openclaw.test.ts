/**
 * Тесты адаптера OpenClaw (JSON, ~/.openclaw/openclaw.json).
 *
 * Реальный OpenClaw использует JSON-конфиг с вложенной структурой
 * models.providers.<id> + agents.defaults. Проверяем:
 * - валидный JSON: провайдер gonka (api openai-completions, baseUrl С /v1,
 *   без поля auth, apiKey = ИМЯ env-переменной), модели каталога с верными maxTokens;
 * - agents.defaults.model.primary = gonka/moonshotai/Kimi-K2.6, алиасы каталога;
 * - повторный apply убирает устаревшие модели (Qwen) из каталога/алиасов/primary;
 * - ключ jg-... пишется ЛИТЕРАЛОМ в конфиг (0o600), без env-переменной; messages
 *   НЕ содержит export GONKA_API_KEY (env-ссылка падала «SecretRef unresolved»);
 * - deep-merge: чужой провайдер (openai) и чужие алиасы сохраняются;
 * - primary НЕ перезаписывается, если уже задан пользователем;
 * - upsert моделей по id: два apply подряд → нет дублей, идемпотентность;
 * - бэкап при наличии файла, отсутствие бэкапа без файла, битый JSON;
 * - путь уважает OPENCLAW_CONFIG_PATH;
 * - chmod 600 на записанный файл.
 *
 * HOME и OPENCLAW_CONFIG_PATH перенаправляются в tmp; восстановление в afterEach.
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
import { openclawAdapter } from './openclaw.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalConfigPath: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-oc-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  // OPENCLAW_CONFIG_PATH мог быть установлен в окружении — изолируем тесты
  originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_CONFIG_PATH;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (scope: 'user' | 'local' = 'user') => ({
  apiKey: 'jg-test123',
  model: DEFAULT_MODEL,
  scope,
});

/** Путь к дефолтному конфигу внутри tmp-HOME. */
const defaultConfigPath = () => join(tmpDir, '.openclaw', 'openclaw.json');

/** Прочитать и распарсить записанный JSON-конфиг. */
const readConfig = (path = defaultConfigPath()) =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;

describe('openclawAdapter.resolvePath', () => {
  it('returns ~/.openclaw/openclaw.json for user scope by default', () => {
    expect(openclawAdapter.resolvePath('user')).toBe(defaultConfigPath());
  });

  it('honours OPENCLAW_CONFIG_PATH when set', () => {
    const custom = join(tmpDir, 'custom-dir', 'my-openclaw.json');
    process.env.OPENCLAW_CONFIG_PATH = custom;
    expect(openclawAdapter.resolvePath('user')).toBe(custom);
  });
});

describe('openclawAdapter.apply — provider block', () => {
  it('writes the gonka provider with api=openai-completions and baseUrl WITH /v1', async () => {
    const result = await openclawAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(defaultConfigPath());

    const cfg = readConfig();
    const provider = cfg.models.providers.gonka;
    expect(provider).toBeDefined();
    expect(provider.api).toBe('openai-completions');
    // OpenAI-режим: baseUrl С /v1 (наш зрелый роут /v1/chat/completions)
    expect(provider.baseUrl).toBe('https://gate.joingonka.ai/v1');
    expect(provider.baseUrl).toContain('/v1');
  });

  it('does NOT write an auth field (OpenAI mode, like GonkaGate)', async () => {
    await openclawAdapter.apply(input());
    const provider = readConfig().models.providers.gonka;
    expect('auth' in provider).toBe(false);
  });

  it('writes apiKey as the LITERAL key (not a ${ENV} ref → works without env)', async () => {
    await openclawAdapter.apply(input());
    const cfg = readConfig();
    // Литерал jg-...: OpenClaw без ${...} берёт значение как есть и НЕ падает
    // «SecretRef unresolved», если переменной нет в окружении gateway.
    expect(cfg.models.providers.gonka.apiKey).toBe('jg-test123');
    expect(cfg.models.providers.gonka.apiKey).not.toContain('${');
  });

  it('writes models.mode = "merge" (сливать наш каталог с бандлами, не заменять)', async () => {
    await openclawAdapter.apply(input());
    expect(readConfig().models.mode).toBe('merge');
  });

  it('writes both Gonka models with correct maxTokens', async () => {
    await openclawAdapter.apply(input());
    const models = readConfig().models.providers.gonka.models as Array<Record<string, any>>;
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(models).toHaveLength(2);
    // :online-вариантов больше нет — веб-поиск в OpenClaw через его tools.web.
    expect(models.some((m) => String(m.id).endsWith(':online'))).toBe(false);
    expect(byId.get('moonshotai/Kimi-K2.6')?.maxTokens).toBe(3072);
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.maxTokens).toBe(4096);

    // Форма записи модели
    const kimi = byId.get('moonshotai/Kimi-K2.6')!;
    expect(kimi.name).toBe('Kimi K2.6 (Gonka)');
    expect(kimi.input).toEqual(['text']);
    expect(kimi.contextWindow).toBe(131072);
    expect(kimi.cost).toEqual({ input: 0.07, output: 0.1, cacheRead: 0.07, cacheWrite: 0.07 });
  });

  it('preserves the canonical casing of model ids (NOT lowercase)', async () => {
    await openclawAdapter.apply(input());
    const ids = (readConfig().models.providers.gonka.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('moonshotai/Kimi-K2.6');
    expect(ids).not.toContain('moonshotai/kimi-k2.6');
  });
});

describe('openclawAdapter.apply — agents defaults', () => {
  it('sets primary to gonka/moonshotai/Kimi-K2.6 and registers 2 aliases', async () => {
    await openclawAdapter.apply(input());
    const defaults = readConfig().agents.defaults;

    expect(defaults.model.primary).toBe('gonka/moonshotai/Kimi-K2.6');
    expect(defaults.models['gonka/moonshotai/Kimi-K2.6']).toEqual({ alias: 'kimi-k2.6' });
    expect(defaults.models['gonka/MiniMaxAI/MiniMax-M2.7']).toEqual({ alias: 'minimax-m2.7' });
  });
});

describe('openclawAdapter.apply — secret safety', () => {
  it('writes the literal jg- key into the (0o600) config — no env dependency', async () => {
    await openclawAdapter.apply(input());
    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).toContain('jg-test123');
    expect(raw).not.toContain('${GONKA_API_KEY}');
  });

  it('does NOT instruct an env export (key lives in the config now)', async () => {
    const result = await openclawAdapter.apply(input());
    const joined = result.messages.join('\n');
    expect(joined).not.toMatch(/export\s+GONKA_API_KEY=/);
    expect(joined).toContain('0o600');
  });
});

describe('openclawAdapter.apply — deep merge (do not clobber foreign data)', () => {
  it('preserves a pre-existing foreign provider (openai)', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        models: {
          providers: {
            openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'OPENAI_API_KEY' },
          },
        },
      }),
    );

    await openclawAdapter.apply(input());

    const providers = readConfig().models.providers;
    expect(providers.openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'OPENAI_API_KEY',
    });
    expect(providers.gonka).toBeDefined();
  });

  it('preserves unknown fields inside an existing gonka provider', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        models: { providers: { gonka: { customField: 'keep-me' } } },
      }),
    );

    await openclawAdapter.apply(input());

    const provider = readConfig().models.providers.gonka;
    expect(provider.customField).toBe('keep-me');
    expect(provider.api).toBe('openai-completions');
  });

  it("preserves foreign agents.defaults.models aliases", async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        agents: { defaults: { models: { 'openai/gpt-5.4': { alias: 'gpt' } } } },
      }),
    );

    await openclawAdapter.apply(input());

    const models = readConfig().agents.defaults.models;
    expect(models['openai/gpt-5.4']).toEqual({ alias: 'gpt' });
    expect(models['gonka/moonshotai/Kimi-K2.6']).toEqual({ alias: 'kimi-k2.6' });
  });

  it('does NOT overwrite a user-set primary', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        agents: { defaults: { model: { primary: 'openai/gpt-5.4' } } },
      }),
    );

    await openclawAdapter.apply(input());

    expect(readConfig().agents.defaults.model.primary).toBe('openai/gpt-5.4');
  });

  it('DOES set primary when none was set before', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: {} } } }),
    );

    await openclawAdapter.apply(input());

    expect(readConfig().agents.defaults.model.primary).toBe('gonka/moonshotai/Kimi-K2.6');
  });

  it('убирает устаревшую модель (Qwen) из каталога, алиасов и primary на повторном apply', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        models: {
          providers: {
            gonka: {
              models: [
                { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', name: 'Qwen (old)' },
                { id: 'moonshotai/Kimi-K2.6', name: 'stale' },
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: 'gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8' },
            models: {
              'gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { alias: 'qwen' },
              'openai/gpt-5.4': { alias: 'gpt' },
            },
          },
        },
      }),
    );

    await openclawAdapter.apply(input());

    const cfg = readConfig();
    const ids = cfg.models.providers.gonka.models.map((m: any) => m.id);
    expect(ids).not.toContain('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8'); // убрана из каталога
    expect(ids).toContain('moonshotai/Kimi-K2.6');
    expect(ids).toContain('MiniMaxAI/MiniMax-M2.7');

    const aliases = cfg.agents.defaults.models;
    expect(aliases['gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined(); // наш устаревший алиас убран
    expect(aliases['openai/gpt-5.4']).toEqual({ alias: 'gpt' }); // чужой алиас цел
    expect(aliases['gonka/moonshotai/Kimi-K2.6']).toEqual({ alias: 'kimi-k2.6' });

    expect(cfg.agents.defaults.model.primary).toBe('gonka/moonshotai/Kimi-K2.6'); // primary на Qwen → сброшен
  });
});

describe('openclawAdapter.apply — upsert / idempotency', () => {
  it('does not create duplicate model entries on a second apply', async () => {
    await openclawAdapter.apply(input());
    await openclawAdapter.apply(input());

    const models = readConfig().models.providers.gonka.models as Array<{ id: string }>;
    const ids = models.map((m) => m.id);
    const unique = new Set(ids);
    expect(ids).toHaveLength(unique.size);
    expect(models).toHaveLength(2);
  });

  it('is byte-identical on a second apply (idempotent)', async () => {
    await openclawAdapter.apply(input());
    const first = readFileSync(defaultConfigPath(), 'utf-8');
    await openclawAdapter.apply(input());
    const second = readFileSync(defaultConfigPath(), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('openclawAdapter.apply — backups & malformed', () => {
  it('creates a backup when the file already exists', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ models: {} }));

    const result = await openclawAdapter.apply(input());

    expect(result.backupPath).not.toBeNull();
    const backups = readdirSync(dir).filter((f) => f.startsWith('openclaw.json.bak.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('does not create a backup when the file does not exist', async () => {
    const result = await openclawAdapter.apply(input());
    expect(result.backupPath).toBeNull();
  });

  it('handles malformed existing JSON by starting fresh and backing up', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), '{ this is : not json ]');

    await openclawAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.models.providers.gonka.api).toBe('openai-completions');
    const backups = readdirSync(dir).filter((f) => f.startsWith('openclaw.json.bak.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('respects OPENCLAW_CONFIG_PATH for the write target', async () => {
    const custom = join(tmpDir, 'nested', 'cfg.json');
    process.env.OPENCLAW_CONFIG_PATH = custom;

    const result = await openclawAdapter.apply(input());

    expect(result.configPath).toBe(custom);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(defaultConfigPath())).toBe(false);
    expect(readConfig(custom).models.providers.gonka.api).toBe('openai-completions');
  });
});

describe('openclawAdapter.apply — file permissions', () => {
  // chmod-биты не воспроизводятся на Windows; проверяем только на posix
  it.runIf(platform() !== 'win32')('writes the file with 0o600 permissions', async () => {
    await openclawAdapter.apply(input());
    const mode = statSync(defaultConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
