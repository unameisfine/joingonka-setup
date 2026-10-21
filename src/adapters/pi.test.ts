/**
 * Тесты адаптера Pi (JSON ~/.pi/agent/models.json + settings.json).
 *
 * Проверяем:
 * - провайдер joingonka: baseUrl С /v1, api=openai-completions, ключ ЛИТЕРАЛОМ
 *   (Pi умеет $VAR, но env установщик не персистит), модели с честными
 *   contextWindow/maxTokens (не дефолты Pi 128000/16384);
 * - дефолт в ОТДЕЛЬНОМ файле settings.json (defaultProvider/defaultModel):
 *   ставится если не задан, обновляется если наш и устарел, НЕ трогается если
 *   выбран чужой провайдер;
 * - правки точечные: чужие провайдеры, чужие поля внутри нашего и комментарии
 *   сохраняются;
 * - reconcile: устаревшая модель (Qwen) уходит из каталога;
 * - битый models.json ИЛИ settings.json → отказ без записи и без бэкапа;
 * - путь: PI_CODING_AGENT_DIR (каталог агента целиком), а не выдуманная PI_HOME;
 * - бэкап, идемпотентность, живая цена, chmod 600.
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
import { piAdapter, piAgentDir } from './pi.js';
import { DEFAULT_MODEL, DEEPSEEK_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-pi-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  // PI_CODING_AGENT_DIR мог быть задан в окружении разработчика — изолируем тесты
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (scope: 'user' | 'local' = 'user') => ({
  apiKey: 'jg-test123',
  model: DEFAULT_MODEL,
  scope,
});

const modelsPath = () => join(tmpDir, '.pi', 'agent', 'models.json');
const settingsFile = () => join(tmpDir, '.pi', 'agent', 'settings.json');
const readModels = (path = modelsPath()) =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
const readSettings = () => JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Record<string, any>;

/** Что лежит в ~/.pi/agent/ (для проверок «ничего лишнего не появилось»). */
const agentFiles = () => readdirSync(join(tmpDir, '.pi', 'agent')).sort();

/** Записать файл в ~/.pi/agent/. */
const seed = (name: string, contents: string) => {
  const dir = join(tmpDir, '.pi', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
};

describe('piAdapter.resolvePath', () => {
  it('returns ~/.pi/agent/models.json by default', () => {
    expect(piAdapter.resolvePath('user')).toBe(modelsPath());
  });

  it('honours PI_CODING_AGENT_DIR — it replaces the whole ~/.pi/agent directory', () => {
    const custom = join(tmpDir, 'portable-pi-agent');
    process.env.PI_CODING_AGENT_DIR = custom;
    // Переменная указывает на сам каталог агента: «agent» к ней НЕ дописывается.
    expect(piAdapter.resolvePath('user')).toBe(join(custom, 'models.json'));
  });

  it('ignores PI_HOME — Pi never read such a variable', () => {
    // До 0.4.5 установщик уважал выдуманную PI_HOME и писал туда, куда Pi не
    // смотрит. Исходник Pi (packages/coding-agent/src/config.ts, 21.09.2026)
    // знает только PI_CODING_AGENT_DIR.
    process.env.PI_HOME = join(tmpDir, 'fantasy');
    try {
      expect(piAdapter.resolvePath('user')).toBe(modelsPath());
    } finally {
      delete process.env.PI_HOME;
    }
  });
});

describe('piAgentDir', () => {
  const ctx = (env: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, env, home: '/home/u' });

  it('defaults to ~/.pi/agent', () => {
    expect(piAgentDir(ctx({}))).toBe('/home/u/.pi/agent');
  });

  it('expands a leading tilde the way Pi does', () => {
    expect(piAgentDir(ctx({ PI_CODING_AGENT_DIR: '~/work/pi' }))).toBe('/home/u/work/pi');
  });

  it('uses Windows separators on Windows', () => {
    expect(piAgentDir({ platform: 'win32', env: {}, home: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\.pi\\agent',
    );
  });
});

describe('piAdapter.apply — provider block', () => {
  it('writes baseUrl WITH /v1, api=openai-completions and the literal key', async () => {
    const result = await piAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(modelsPath());

    const provider = readModels().providers.joingonka;
    expect(provider.baseUrl).toBe('https://gate.joingonka.ai/v1');
    expect(provider.api).toBe('openai-completions');
    // Литерал, НЕ $GONKA_API_KEY: env-ссылку установщик не персистит
    expect(provider.apiKey).toBe('jg-test123');
    expect(JSON.stringify(provider)).not.toContain('$');
  });

  it('writes all network models with real limits (not pi defaults 128000/16384)', async () => {
    await piAdapter.apply(input());
    const models = readModels().providers.joingonka.models as Array<Record<string, any>>;
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(models).toHaveLength(3);
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.contextWindow).toBe(180000);
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.maxTokens).toBe(8192);
    // GLM-5.3 Flash — контекст 390K (замер 16.09.2026), выдача на общем клипе 8192
    expect(byId.get('zai-org/GLM-5.3-Flash')?.contextWindow).toBe(390000);
    expect(byId.get('zai-org/GLM-5.3-Flash')?.maxTokens).toBe(8192);
    // Пер-модельный контекст DeepSeek — 380K, выдача 32768 (выше общего клипа 8192)
    expect(byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.contextWindow).toBe(380000);
    expect(byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.maxTokens).toBe(32768);
    // reasoning-флаг только у reasoning-моделей
    expect(byId.get('zai-org/GLM-5.3-Flash')?.reasoning).toBe(true);
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.reasoning).toBeUndefined();
    expect(byId.get('MiniMaxAI/MiniMax-M2.7')?.input).toEqual(['text']);
  });

  it('preserves foreign providers and foreign fields inside ours', async () => {
    seed(
      'models.json',
      JSON.stringify({
        providers: {
          ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions' },
          joingonka: { customField: 'keep-me' },
        },
      }),
    );

    await piAdapter.apply(input());

    const providers = readModels().providers;
    expect(providers.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(providers.joingonka.customField).toBe('keep-me');
    expect(providers.joingonka.api).toBe('openai-completions');
  });

  it('drops a stale model (Qwen) from our catalog on re-run', async () => {
    seed(
      'models.json',
      JSON.stringify({
        providers: {
          joingonka: {
            models: [{ id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', name: 'Qwen (old)' }],
          },
        },
      }),
    );

    await piAdapter.apply(input());

    const ids = readModels().providers.joingonka.models.map((m: any) => m.id);
    expect(ids).not.toContain('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8');
    expect(ids).toContain('MiniMaxAI/MiniMax-M2.7');
  });
});

describe('piAdapter.apply — default model lives in settings.json', () => {
  it('sets defaultProvider/defaultModel when none exists', async () => {
    await piAdapter.apply(input());
    const settings = readSettings();
    expect(settings.defaultProvider).toBe('joingonka');
    expect(settings.defaultModel).toBe(DEFAULT_MODEL);
  });

  it('preserves other settings keys while setting the default', async () => {
    seed('settings.json', JSON.stringify({ theme: 'dark', autoUpdate: false }));

    await piAdapter.apply(input());

    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.autoUpdate).toBe(false);
    expect(settings.defaultModel).toBe(DEFAULT_MODEL);
  });

  it('does NOT hijack a foreign provider default', async () => {
    seed(
      'settings.json',
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4' }),
    );

    const result = await piAdapter.apply(input());

    const settings = readSettings();
    expect(settings.defaultProvider).toBe('anthropic');
    expect(settings.defaultModel).toBe('claude-sonnet-4');
    expect(result.messages.join('\n')).toContain('Kept your existing default model');
  });

  it('refreshes OUR stale default model', async () => {
    seed(
      'settings.json',
      JSON.stringify({
        defaultProvider: 'joingonka',
        defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
      }),
    );

    await piAdapter.apply({ ...input(), model: DEEPSEEK_MODEL });

    expect(readSettings().defaultModel).toBe(DEEPSEEK_MODEL);
  });

  it('refuses when settings.json cannot be parsed — before touching models.json', async () => {
    // Оба файла читаются ДО первой записи: иначе половина установки прошла бы
    // (провайдер записан), а вторая упала, и человек остался бы с конфигом, про
    // который непонятно, применился он или нет.
    seed('settings.json', '{ broken json ]');
    seed('models.json', '{ "providers": {} }');

    await expect(piAdapter.apply(input())).rejects.toThrow(/settings\.json.*Nothing was written/s);

    expect(readFileSync(settingsFile(), 'utf-8')).toBe('{ broken json ]');
    expect(readFileSync(modelsPath(), 'utf-8')).toBe('{ "providers": {} }');
    expect(agentFiles().filter((f) => f.includes('.bak.'))).toHaveLength(0);
  });

  it('writes an explicit --model even over a foreign default', async () => {
    seed(
      'settings.json',
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4' }),
    );

    await piAdapter.apply({ ...input(), model: DEEPSEEK_MODEL, modelExplicit: true });

    expect(readSettings()).toMatchObject({
      defaultProvider: 'joingonka',
      defaultModel: DEEPSEEK_MODEL,
    });
  });

  it('keeps comments and the key order of settings.json', async () => {
    seed('settings.json', '{\n  // мои настройки\n  "theme": "dark",\n}');

    await piAdapter.apply(input());

    const raw = readFileSync(settingsFile(), 'utf-8');
    expect(raw).toContain('// мои настройки');
    expect(raw.indexOf('"theme"')).toBeLessThan(raw.indexOf('"defaultProvider"'));
  });
});

describe('piAdapter.apply — backups, malformed, idempotency, permissions', () => {
  it('creates a backup when models.json exists', async () => {
    seed('models.json', JSON.stringify({ providers: {} }));
    const result = await piAdapter.apply(input());
    expect(result.backupPath).not.toBeNull();
  });

  it('does not create a backup when the file does not exist', async () => {
    const result = await piAdapter.apply(input());
    expect(result.backupPath).toBeNull();
  });

  it('refuses a models.json it cannot parse (no write, no backup)', async () => {
    // ★ До 0.4.5 такой файл заменялся свежим: пропадали ключи и каталоги ВСЕХ
    // остальных провайдеров пользователя (Ollama, vLLM, свои прокси).
    seed('models.json', '{ not json ]');

    await expect(piAdapter.apply(input())).rejects.toThrow(/models\.json.*Nothing was written/s);

    expect(readFileSync(modelsPath(), 'utf-8')).toBe('{ not json ]');
    expect(agentFiles()).toEqual(['models.json']); // ни бэкапа, ни settings.json
  });

  it('keeps comments and trailing commas in models.json', async () => {
    seed(
      'models.json',
      `{
  // локальная ollama, не трогать
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", },
  },
}`,
    );

    await piAdapter.apply(input());

    const raw = readFileSync(modelsPath(), 'utf-8');
    expect(raw).toContain('// локальная ollama, не трогать');
    expect(raw).toContain('"ollama"');
    expect(raw).toContain('"joingonka"');
  });

  it('is byte-identical on a second apply', async () => {
    await piAdapter.apply(input());
    const first = readFileSync(modelsPath(), 'utf-8');
    await piAdapter.apply(input());
    expect(readFileSync(modelsPath(), 'utf-8')).toBe(first);
  });

  it('respects PI_CODING_AGENT_DIR for both files', async () => {
    const custom = join(tmpDir, 'portable-pi-agent');
    process.env.PI_CODING_AGENT_DIR = custom;

    const result = await piAdapter.apply(input());

    expect(result.configPath).toBe(join(custom, 'models.json'));
    expect(existsSync(join(custom, 'models.json'))).toBe(true);
    expect(existsSync(join(custom, 'settings.json'))).toBe(true);
    expect(existsSync(modelsPath())).toBe(false);
  });

  it('writes the live price handed over by the orchestrator', async () => {
    await piAdapter.apply({ ...input(), pricing: { input: 0.005808, output: 0.017424 } });

    for (const model of readModels().providers.joingonka.models) {
      expect(model.cost).toEqual({
        input: 0.005808,
        output: 0.017424,
        cacheRead: 0.005808,
        cacheWrite: 0.005808,
      });
    }
    expect(piAdapter.wantsPricing).toBe(true);
  });

  it('falls back to the built-in price without live pricing', async () => {
    await piAdapter.apply(input());
    expect(readModels().providers.joingonka.models[0].cost.input).toBe(0.0062);
  });

  it.runIf(platform() !== 'win32')('writes models.json with 0o600 permissions', async () => {
    await piAdapter.apply(input());
    expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
  });
});

describe('piAdapter.apply — неожиданная форма узла (0.4.5)', () => {
  // Оба итоговых текста считаются ДО первого бэкапа и первой записи.
  it('refuses when `providers` is not an object: nothing written, no backups', async () => {
    const original = '{ "providers": ["ollama"] }';
    seed('models.json', original);
    seed('settings.json', '{ "theme": "dark" }');

    await expect(piAdapter.apply(input())).rejects.toThrow(
      /models\.json.*"providers" is an array.*Nothing was written/s,
    );

    expect(readFileSync(modelsPath(), 'utf-8')).toBe(original);
    expect(readFileSync(settingsFile(), 'utf-8')).toBe('{ "theme": "dark" }');
    expect(agentFiles()).toEqual(['models.json', 'settings.json']);
  });
});
