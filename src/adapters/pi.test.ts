/**
 * Тесты адаптера Pi (JSON ~/.pi/agent/models.json + settings.json).
 *
 * Проверяем:
 * - провайдер joingonka: baseUrl С /v1, api=openai-completions, ключ ЛИТЕРАЛОМ
 *   (Pi умеет $VAR, но env установщик не персистит), модели с честными
 *   contextWindow/maxTokens (не дефолты Pi 128000/16384);
 * - дефолт в ОТДЕЛЬНОМ файле settings.json (defaultProvider/defaultModel):
 *   ставится если не задан, обновляется если наш и устарел, НЕ трогается если
 *   выбран чужой провайдер; битый settings.json не перезаписывается;
 * - deep-merge: чужие провайдеры и чужие поля внутри нашего сохраняются;
 * - reconcile: устаревшая модель (Qwen) уходит из каталога;
 * - бэкап, битый models.json, идемпотентность, PI_HOME, chmod 600.
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
import { piAdapter } from './pi.js';
import { DEFAULT_MODEL, DEEPSEEK_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalPiHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-pi-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  originalPiHome = process.env.PI_HOME;
  delete process.env.PI_HOME;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiHome === undefined) delete process.env.PI_HOME;
  else process.env.PI_HOME = originalPiHome;
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

  it('honours PI_HOME (directory)', () => {
    const custom = join(tmpDir, 'portable-pi');
    process.env.PI_HOME = custom;
    expect(piAdapter.resolvePath('user')).toBe(join(custom, 'agent', 'models.json'));
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
    expect(byId.get('moonshotai/Kimi-K2.6')?.contextWindow).toBe(200000);
    expect(byId.get('moonshotai/Kimi-K2.6')?.maxTokens).toBe(8192);
    // Пер-модельный контекст DeepSeek — 380K, выдача 32768 (выше общего клипа 8192)
    expect(byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.contextWindow).toBe(380000);
    expect(byId.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.maxTokens).toBe(32768);
    // reasoning-флаг только у reasoning-моделей
    expect(byId.get('moonshotai/Kimi-K2.6')?.reasoning).toBe(true);
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

  it('leaves a malformed settings.json untouched and says so', async () => {
    seed('settings.json', '{ broken json ]');

    const result = await piAdapter.apply(input());

    // Файл не перезаписан — провайдер работает и без дефолта
    expect(readFileSync(settingsFile(), 'utf-8')).toBe('{ broken json ]');
    expect(result.messages.join('\n')).toContain('not valid JSON');
    // ...но основной конфиг записан
    expect(readModels().providers.joingonka.api).toBe('openai-completions');
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

  it('handles a malformed models.json by starting fresh and backing up', async () => {
    seed('models.json', '{ not json ]');

    await piAdapter.apply(input());

    expect(readModels().providers.joingonka.api).toBe('openai-completions');
    const backups = readdirSync(join(tmpDir, '.pi', 'agent')).filter((f) =>
      f.startsWith('models.json.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it('is byte-identical on a second apply', async () => {
    await piAdapter.apply(input());
    const first = readFileSync(modelsPath(), 'utf-8');
    await piAdapter.apply(input());
    expect(readFileSync(modelsPath(), 'utf-8')).toBe(first);
  });

  it('respects PI_HOME for the write target', async () => {
    const custom = join(tmpDir, 'portable-pi');
    process.env.PI_HOME = custom;

    const result = await piAdapter.apply(input());

    expect(result.configPath).toBe(join(custom, 'agent', 'models.json'));
    expect(existsSync(join(custom, 'agent', 'models.json'))).toBe(true);
    expect(existsSync(modelsPath())).toBe(false);
  });

  it.runIf(platform() !== 'win32')('writes models.json with 0o600 permissions', async () => {
    await piAdapter.apply(input());
    expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
  });
});
