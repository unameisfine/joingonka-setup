/**
 * Тесты адаптера OpenClaw (JSON, ~/.openclaw/openclaw.json).
 *
 * Реальный OpenClaw использует JSON-конфиг с вложенной структурой
 * models.providers.<id> + agents.defaults. Проверяем:
 * - валидный JSON: провайдер gonka (api openai-completions, baseUrl С /v1,
 *   без поля auth, apiKey = ИМЯ env-переменной), модели каталога с верными maxTokens;
 * - agents.defaults.model.primary = gonka/MiniMaxAI/MiniMax-M2.7, алиасы каталога;
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
import {
  DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  GLM_MODEL,
  OPENCLAW_DEFAULT_PRIMARY,
} from '../constants.js';

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

  it('writes all Gonka models with correct maxTokens', async () => {
    await openclawAdapter.apply(input());
    const models = readConfig().models.providers.gonka.models as Array<Record<string, any>>;
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(models).toHaveLength(3);
    // :online-вариантов больше нет — веб-поиск в OpenClaw через его tools.web.
    expect(models.some((m) => String(m.id).endsWith(':online'))).toBe(false);
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.maxTokens).toBe(8192);
    expect(byId.get('zai-org/GLM-5.3-Flash')?.maxTokens).toBe(8192);
    // DeepSeek — ЕДИНСТВЕННАЯ модель сети с потолком выдачи выше общего клипа:
    // 32768 (замер 17.08.2026, SSOT model-specs.ts + live /v1/models).
    expect(byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.maxTokens).toBe(32768);

    // Форма записи модели на примере MiniMax: окно 180K — on-chain --max-model-len хостов
    const minimax = byId.get('MiniMaxAI/MiniMax-M2.7')!;
    expect(minimax.name).toBe('MiniMax M2.7 (Gonka)');
    expect(minimax.input).toEqual(['text']);
    expect(minimax.contextWindow).toBe(180000);
    expect(minimax.cost).toEqual({
      input: 0.0062,
      output: 0.0185,
      cacheRead: 0.0062,
      cacheWrite: 0.0062,
    });

    // Пер-модельный контекст: DeepSeek 380K (замер 13.08.2026), не окно MiniMax
    const deepseek = byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')!;
    expect(deepseek.name).toBe('DeepSeek V4 Flash (Gonka)');
    expect(deepseek.contextWindow).toBe(380000);

    // GLM-5.3 Flash (в сети с 16.09.2026): контекст 390K, потолок выдачи 8192 — замер
    const glm = byId.get('zai-org/GLM-5.3-Flash')!;
    expect(glm.name).toBe('GLM 5.3 Flash (Gonka)');
    expect(glm.contextWindow).toBe(390000);
  });

  it('preserves the canonical casing of model ids (NOT lowercase)', async () => {
    await openclawAdapter.apply(input());
    const ids = (readConfig().models.providers.gonka.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('zai-org/GLM-5.3-Flash');
    expect(ids).not.toContain('zai-org/glm-5.3-flash');
  });
});

describe('openclawAdapter.apply — agents defaults', () => {
  it('sets primary to the coding-agent default and registers an alias per model', async () => {
    await openclawAdapter.apply(input());
    const defaults = readConfig().agents.defaults;

    expect(defaults.model.primary).toBe(OPENCLAW_DEFAULT_PRIMARY);
    expect(defaults.models['gonka/MiniMaxAI/MiniMax-M2.7']).toEqual({ alias: 'minimax-m2.7' });
    expect(defaults.models['gonka/deepseek-ai/DeepSeek-V4-Flash-0731']).toEqual({
      alias: 'deepseek-v4-flash',
    });
    expect(defaults.models['gonka/zai-org/GLM-5.3-Flash']).toEqual({ alias: 'glm-5.3-flash' });
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
    expect(models['gonka/zai-org/GLM-5.3-Flash']).toEqual({ alias: 'glm-5.3-flash' });
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

    expect(readConfig().agents.defaults.model.primary).toBe(OPENCLAW_DEFAULT_PRIMARY);
  });

  it('убирает ушедшие модели (Qwen, Kimi) из каталога, алиасов и primary на повторном apply', async () => {
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
                // Kimi K2.6 ушла из сети 09.2026 — осталась от прошлого запуска установщика
                { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6 (Gonka)' },
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: 'gonka/moonshotai/Kimi-K2.6' },
            models: {
              'gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { alias: 'qwen' },
              'gonka/moonshotai/Kimi-K2.6': { alias: 'kimi-k2.6' },
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
    expect(ids).not.toContain('moonshotai/Kimi-K2.6'); // ушедшая из сети Kimi — тоже
    expect(ids).toContain('MiniMaxAI/MiniMax-M2.7');
    expect(ids).toContain('zai-org/GLM-5.3-Flash');

    const aliases = cfg.agents.defaults.models;
    expect(aliases['gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined(); // наш устаревший алиас убран
    expect(aliases['gonka/moonshotai/Kimi-K2.6']).toBeUndefined(); // и алиас ушедшей Kimi
    expect(aliases['openai/gpt-5.4']).toEqual({ alias: 'gpt' }); // чужой алиас цел
    expect(aliases['gonka/zai-org/GLM-5.3-Flash']).toEqual({ alias: 'glm-5.3-flash' });

    expect(cfg.agents.defaults.model.primary).toBe(OPENCLAW_DEFAULT_PRIMARY); // primary на ушедшую Kimi → сброшен
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
    expect(models).toHaveLength(3);
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

  it('refuses to touch a config it cannot parse (no write, no backup)', async () => {
    // ★ Класс дефекта, закрытый в 0.4.5: раньше такой файл молча заменялся
    // свежим конфигом, и пользователь терял всё остальное содержимое.
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    const configFile = join(dir, 'openclaw.json');
    writeFileSync(configFile, '{ this is : not json ]');

    await expect(openclawAdapter.apply(input())).rejects.toThrow(/Nothing was written/);

    expect(readFileSync(configFile, 'utf8')).toBe('{ this is : not json ]');
    expect(readdirSync(dir).filter((f) => f.startsWith('openclaw.json.bak.'))).toHaveLength(0);
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

describe('openclawAdapter.apply — JSONC и явная модель (0.4.5)', () => {
  it('keeps comments, trailing commas and foreign settings intact', async () => {
    // openclaw.json — JSON5: комментарии и висячие запятые законны. Раньше такой
    // файл не парсился, адаптер стартовал с {} и уносил конфигурацию целиком.
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      `{
  // мои MCP-серверы, не трогать
  "mcp": { "servers": { "local": { "command": "node" } }, },
  "channels": ["telegram"],
}`,
    );

    await openclawAdapter.apply(input());

    const raw = readFileSync(join(dir, 'openclaw.json'), 'utf-8');
    expect(raw).toContain('// мои MCP-серверы, не трогать');
    expect(raw).toContain('"channels"');
    expect(raw).toContain('"local"');
    expect(raw).toContain('"gonka"');
  });

  it('writes an explicit --model into primary', async () => {
    await openclawAdapter.apply({ ...input(), model: GLM_MODEL, modelExplicit: true });
    expect(readConfig().agents.defaults.model.primary).toBe(`gonka/${GLM_MODEL}`);
  });

  it('keeps the primary chosen by the user when no model was requested', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'openai/gpt-5.4' } } } }),
    );

    const result = await openclawAdapter.apply(input());

    expect(readConfig().agents.defaults.model.primary).toBe('openai/gpt-5.4');
    // И сообщение не врёт про «Default model: …наш дефолт».
    expect(result.messages.join('\n')).toContain('openai/gpt-5.4');
  });

  it('adds fallbacks without the primary, and never overrides the user list', async () => {
    await openclawAdapter.apply(input());
    const fallbacks = readConfig().agents.defaults.model.fallbacks as string[];
    expect(fallbacks).toEqual([`gonka/${GLM_MODEL}`, `gonka/${DEFAULT_MODEL}`]);
    expect(fallbacks).not.toContain(`gonka/${DEEPSEEK_MODEL}`); // это primary

    const dir = join(tmpDir, '.openclaw');
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { fallbacks: ['openai/gpt-5.4'] } } } }),
    );
    await openclawAdapter.apply(input());
    expect(readConfig().agents.defaults.model.fallbacks).toEqual(['openai/gpt-5.4']);
  });
});

describe('openclawAdapter.apply — ушедшие модели ВНЕ каталога провайдера (0.4.5)', () => {
  // Каталог и алиасы чистились и раньше, а ссылки на ушедшую модель в запасных
  // и у отдельных агентов оставались: агент, закреплённый за Kimi, после
  // «успешной» переустановки продолжал ходить в модель, которой в сети нет.
  // Формы сверены с докой OpenClaw 21.09.2026 (docs/gateway/config-agents/
  // models.md и entries-and-multi-agent.md): model — строка "provider/model"
  // либо объект { primary, fallbacks }; агенты — `agents.entries.<id>` (сейчас)
  // и `agents.list[]` (прежняя форма, её переносит `openclaw doctor --fix`).
  const KIMI = 'gonka/moonshotai/Kimi-K2.6';

  const seed = (config: unknown) => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(config, null, 2));
  };

  it('drops our retired models from the user fallbacks and keeps everything else', async () => {
    seed({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-5.4',
            fallbacks: [KIMI, 'openai/gpt-5.4-mini', `gonka/${DEFAULT_MODEL}`],
          },
        },
      },
    });

    await openclawAdapter.apply(input());

    const model = readConfig().agents.defaults.model;
    expect(model.primary).toBe('openai/gpt-5.4'); // чужой primary цел
    expect(model.fallbacks).toEqual(['openai/gpt-5.4-mini', `gonka/${DEFAULT_MODEL}`]);
  });

  it('writes our fallbacks when the user list held nothing but retired models', async () => {
    seed({ agents: { defaults: { model: { primary: KIMI, fallbacks: [KIMI] } } } });

    await openclawAdapter.apply(input());

    const model = readConfig().agents.defaults.model;
    expect(model.primary).toBe(OPENCLAW_DEFAULT_PRIMARY);
    expect(model.fallbacks).toEqual([`gonka/${GLM_MODEL}`, `gonka/${DEFAULT_MODEL}`]);
  });

  it('repoints agents pinned to a retired model at the actual primary (agents.list)', async () => {
    seed({
      agents: {
        defaults: { model: { primary: 'openai/gpt-5.4' } },
        list: [
          { id: 'coder', model: KIMI, workspace: '~/w' },
          { id: 'writer', model: 'anthropic/claude-opus-5' },
          { id: 'ops', model: { primary: KIMI, fallbacks: [KIMI, 'openai/gpt-5.4-mini'] } },
          { id: 'plain' },
        ],
      },
    });

    await openclawAdapter.apply(input());

    const list = readConfig().agents.list;
    // Фактический primary здесь чужой — агент получает его, а не наш дефолт.
    expect(list[0]).toEqual({ id: 'coder', model: 'openai/gpt-5.4', workspace: '~/w' });
    expect(list[1].model).toBe('anthropic/claude-opus-5'); // чужая ссылка цела
    expect(list[2].model).toEqual({ primary: 'openai/gpt-5.4', fallbacks: ['openai/gpt-5.4-mini'] });
    expect(list[3]).toEqual({ id: 'plain' });
  });

  it('does the same for keyed agents.entries', async () => {
    seed({
      agents: {
        entries: {
          main: { name: 'Main', model: KIMI },
          side: { model: { primary: `gonka/${GLM_MODEL}`, fallbacks: [KIMI] } },
        },
      },
    });

    await openclawAdapter.apply(input());

    const entries = readConfig().agents.entries;
    expect(entries.main).toEqual({ name: 'Main', model: OPENCLAW_DEFAULT_PRIMARY });
    expect(entries.side.model).toEqual({ primary: `gonka/${GLM_MODEL}`, fallbacks: [] });
  });

  it('leaves no trace of the retired model and tells the user what it did', async () => {
    seed({
      models: { providers: { gonka: { models: [{ id: 'moonshotai/Kimi-K2.6' }] } } },
      agents: {
        defaults: {
          model: { primary: KIMI, fallbacks: [KIMI, 'openai/gpt-5.4-mini'] },
          models: { [KIMI]: { alias: 'kimi-k2.6' } },
        },
        list: [{ id: 'coder', model: KIMI }],
      },
    });

    const result = await openclawAdapter.apply(input());

    expect(readFileSync(defaultConfigPath(), 'utf-8')).not.toContain('Kimi');
    expect(result.messages.join('\n')).toMatch(/no longer served/i);
  });

  it('says nothing about retired models when there were none', async () => {
    const result = await openclawAdapter.apply(input());
    expect(result.messages.join('\n')).not.toMatch(/no longer served/i);
  });
});

describe('openclawAdapter.apply — строковая форма agents.defaults.model (0.4.5)', () => {
  // Дока OpenClaw: `model` — строка ИЛИ объект. До 0.4.5 строка роняла установку
  // («Can not add index to parent of type string») уже ПОСЛЕ создания бэкапа.
  const seedModel = (model: unknown) => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model } } }));
  };

  it('keeps a foreign model given as a plain string', async () => {
    seedModel('openai/gpt-5.4');

    const result = await openclawAdapter.apply(input());

    // Строка = «только primary, без запасных»: это выбор пользователя, не трогаем.
    expect(readConfig().agents.defaults.model).toBe('openai/gpt-5.4');
    expect(result.messages.join('\n')).toContain('openai/gpt-5.4');
  });

  it('replaces our retired model given as a plain string', async () => {
    seedModel('gonka/moonshotai/Kimi-K2.6');

    await openclawAdapter.apply(input());

    expect(readConfig().agents.defaults.model).toEqual({
      primary: OPENCLAW_DEFAULT_PRIMARY,
      fallbacks: [`gonka/${GLM_MODEL}`, `gonka/${DEFAULT_MODEL}`],
    });
  });

  it('writes an explicit --model over a plain string', async () => {
    seedModel('openai/gpt-5.4');

    await openclawAdapter.apply({ ...input(), model: GLM_MODEL, modelExplicit: true });

    const model = readConfig().agents.defaults.model;
    expect(model.primary).toBe(`gonka/${GLM_MODEL}`);
    expect(model.fallbacks).toEqual([`gonka/${DEFAULT_MODEL}`]);
  });
});

describe('openclawAdapter.apply — живая цена (0.4.5)', () => {
  it('writes the live price handed over by the orchestrator', async () => {
    await openclawAdapter.apply({ ...input(), pricing: { input: 0.005808, output: 0.017424 } });

    const models = readConfig().models.providers.gonka.models as Array<Record<string, any>>;
    for (const model of models) {
      expect(model.cost).toEqual({
        input: 0.005808,
        output: 0.017424,
        cacheRead: 0.005808,
        cacheWrite: 0.005808,
      });
    }
  });

  it('asks the orchestrator for prices', () => {
    expect(openclawAdapter.wantsPricing).toBe(true);
  });

  // ★ Путь обновления с 0.1.0–0.4.4: в конфиге стоит прежняя константа 0.07 / 0.1
  // (завышена в 5–11 раз). Она живой ценой не была — при недоступном шлюзе её
  // заменяет исправленная константа, а не «сохраняет как уже записанную».
  it('replaces the retired 0.07 / 0.1 constant even when the gateway cannot be reached', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    const retired = { input: 0.07, output: 0.1, cacheRead: 0.07, cacheWrite: 0.07 };
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        models: { providers: { gonka: { models: [{ id: DEFAULT_MODEL, cost: retired }] } } },
      }),
    );

    await openclawAdapter.apply({ ...input(), pricing: null });

    const models = readConfig().models.providers.gonka.models as Array<Record<string, any>>;
    for (const model of models) {
      expect(model.cost).toEqual({ input: 0.0062, output: 0.0185, cacheRead: 0.0062, cacheWrite: 0.0062 });
    }
  });

  it('keeps a price the user tuned by hand when there is no live one', async () => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    const tuned = { input: 0.005, output: 0.015, cacheRead: 0.001, cacheWrite: 0.002 };
    writeFileSync(
      join(dir, 'openclaw.json'),
      JSON.stringify({
        models: { providers: { gonka: { models: [{ id: DEFAULT_MODEL, cost: tuned }] } } },
      }),
    );

    await openclawAdapter.apply({ ...input(), pricing: null });

    const models = readConfig().models.providers.gonka.models as Array<Record<string, any>>;
    expect(models.find((m) => m.id === DEFAULT_MODEL)!.cost).toEqual(tuned);
  });
});

describe('openclawAdapter.apply — неожиданная форма узла (0.4.5)', () => {
  // Правки считаются ДО бэкапа: отказ не должен оставлять после себя .bak.
  it.each([
    ['models', '{ "models": "none", "channels": ["telegram"] }', /"models" is a string/],
    ['agents', '{ "agents": 5 }', /"agents" is a number/],
    ['models.providers', '{ "models": { "providers": [] } }', /"models → providers" is an array/],
  ])('refuses when `%s` has an unexpected shape: no write, no backup', async (_key, original, reason) => {
    const dir = join(tmpDir, '.openclaw');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'openclaw.json');
    writeFileSync(file, original);

    await expect(openclawAdapter.apply(input())).rejects.toThrow(reason);
    await expect(openclawAdapter.apply(input())).rejects.toThrow(/openclaw\.json.*Nothing was written/s);

    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(dir)).toEqual(['openclaw.json']);
  });
});
