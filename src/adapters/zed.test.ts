/**
 * Тесты адаптера Zed (JSONC ~/.config/zed/settings.json).
 *
 * Ключевые инварианты (отличаются от остальных адаптеров!):
 * - ключ в settings.json НЕ пишется вообще (док Zed запрещает; Zed читает его
 *   из keychain/env) → в файле нет jg-..., а в messages есть имя env-переменной
 *   JOINGONKA_API_KEY и UI-путь;
 * - settings.json — главный конфиг редактора с КОММЕНТАРИЯМИ: правки точечные
 *   через jsonc-parser, комментарии и чужие настройки выживают;
 * - схема Zed: max_tokens = КОНТЕКСТ, max_output_tokens = потолок выдачи;
 * - XDG_CONFIG_HOME уважается; битый JSONC → свежий файл + бэкап.
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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { zedAdapter } from './zed.js';
import { DEFAULT_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-zed-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  originalXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (scope: 'user' | 'local' = 'user') => ({
  apiKey: 'jg-test123',
  model: DEFAULT_MODEL,
  scope,
});

const settingsPath = () => join(tmpDir, '.config', 'zed', 'settings.json');
const readRawText = (path = settingsPath()) => readFileSync(path, 'utf-8');
const readConfig = (path = settingsPath()) =>
  parseJsonc(readRawText(path), [], { allowTrailingComma: true }) as Record<string, any>;

const seed = (contents: string) => {
  const dir = join(tmpDir, '.config', 'zed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), contents);
};

describe('zedAdapter.resolvePath', () => {
  it('returns ~/.config/zed/settings.json by default', () => {
    expect(zedAdapter.resolvePath('user')).toBe(settingsPath());
  });

  it('honours XDG_CONFIG_HOME', () => {
    const xdg = join(tmpDir, 'xdg');
    process.env.XDG_CONFIG_HOME = xdg;
    expect(zedAdapter.resolvePath('user')).toBe(join(xdg, 'zed', 'settings.json'));
  });
});

describe('zedAdapter.apply — provider block', () => {
  it('writes api_url WITH /v1 under language_models.openai_compatible', async () => {
    const result = await zedAdapter.apply(input());
    expect(result.wrote).toBe(true);

    const provider = readConfig().language_models.openai_compatible.joingonka;
    expect(provider.api_url).toBe('https://gate.joingonka.ai/v1');
  });

  it('writes models with max_tokens=CONTEXT and max_output_tokens=OUTPUT', async () => {
    await zedAdapter.apply(input());
    const models = readConfig().language_models.openai_compatible.joingonka
      .available_models as Array<Record<string, any>>;
    const byName = new Map(models.map((m) => [m.name, m]));

    expect(models).toHaveLength(3);
    // ⚠️ В схеме Zed max_tokens — это контекстное окно, не потолок выдачи
    expect(byName.get('moonshotai/Kimi-K2.6')?.max_tokens).toBe(200000);
    expect(byName.get('moonshotai/Kimi-K2.6')?.max_output_tokens).toBe(8192);
    expect(byName.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.max_tokens).toBe(380000);
    expect(byName.get('MiniMaxAI/MiniMax-M2.7')?.display_name).toBe('MiniMax M2.7 (Gonka)');
    expect(byName.get('MiniMaxAI/MiniMax-M2.7')?.capabilities.tools).toBe(true);
  });
});

describe('zedAdapter.apply — the key is NEVER written (Zed forbids it)', () => {
  it('does not put the api key anywhere in settings.json', async () => {
    await zedAdapter.apply(input());
    expect(readRawText()).not.toContain('jg-test123');
    expect(readRawText()).not.toContain('api_key');
  });

  it('tells the user the env var name and the UI path instead', async () => {
    const result = await zedAdapter.apply(input());
    const joined = result.messages.join('\n');
    // Имя переменной Zed выводит из id провайдера: joingonka → JOINGONKA_API_KEY
    expect(joined).toContain('JOINGONKA_API_KEY=jg-test123');
    expect(joined).toContain('keychain');
    expect(joined).toContain('does NOT read API keys from settings.json');
  });
});

describe('zedAdapter.apply — JSONC safety (main editor config!)', () => {
  it('preserves user comments and foreign settings', async () => {
    seed(
      [
        '{',
        '  // my theme, hands off',
        '  "theme": "Ayu Dark",',
        '  "buffer_font_size": 15,',
        '  "language_models": {',
        '    "openai": { "api_url": "https://api.openai.com/v1" }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    await zedAdapter.apply(input());

    const raw = readRawText();
    expect(raw).toContain('// my theme, hands off');
    const cfg = readConfig();
    expect(cfg.theme).toBe('Ayu Dark');
    expect(cfg.buffer_font_size).toBe(15);
    // Чужой провайдер внутри language_models цел
    expect(cfg.language_models.openai.api_url).toBe('https://api.openai.com/v1');
    expect(cfg.language_models.openai_compatible.joingonka.api_url).toBe(
      'https://gate.joingonka.ai/v1',
    );
  });

  it('preserves foreign fields inside our own provider block', async () => {
    seed(
      JSON.stringify({
        language_models: { openai_compatible: { joingonka: { custom_field: 'keep-me' } } },
      }),
    );

    await zedAdapter.apply(input());

    const provider = readConfig().language_models.openai_compatible.joingonka;
    expect(provider.custom_field).toBe('keep-me');
    expect(provider.api_url).toBe('https://gate.joingonka.ai/v1');
  });

  it('refreshes the catalog on re-run (stale Qwen disappears)', async () => {
    seed(
      JSON.stringify({
        language_models: {
          openai_compatible: {
            joingonka: {
              available_models: [{ name: 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8' }],
            },
          },
        },
      }),
    );

    await zedAdapter.apply(input());

    const names = readConfig().language_models.openai_compatible.joingonka.available_models.map(
      (m: any) => m.name,
    );
    expect(names).not.toContain('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8');
    expect(names).toContain('MiniMaxAI/MiniMax-M2.7');
  });

  it('is byte-identical on a second apply', async () => {
    await zedAdapter.apply(input());
    const first = readRawText();
    await zedAdapter.apply(input());
    expect(readRawText()).toBe(first);
  });
});

describe('zedAdapter.apply — backups & malformed', () => {
  it('creates a backup when the file exists', async () => {
    seed('{ "theme": "One Dark" }');
    const result = await zedAdapter.apply(input());
    expect(result.backupPath).not.toBeNull();
    const backups = readdirSync(join(tmpDir, '.config', 'zed')).filter((f) =>
      f.startsWith('settings.json.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it('does not create a backup when the file does not exist', async () => {
    const result = await zedAdapter.apply(input());
    expect(result.backupPath).toBeNull();
  });

  it('handles malformed JSONC by starting fresh and backing up', async () => {
    seed('{ "theme": [unclosed');

    await zedAdapter.apply(input());

    expect(readConfig().language_models.openai_compatible.joingonka.api_url).toBe(
      'https://gate.joingonka.ai/v1',
    );
    const backups = readdirSync(join(tmpDir, '.config', 'zed')).filter((f) =>
      f.startsWith('settings.json.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it('respects XDG_CONFIG_HOME for the write target', async () => {
    const xdg = join(tmpDir, 'xdg');
    process.env.XDG_CONFIG_HOME = xdg;

    const result = await zedAdapter.apply(input());

    expect(result.configPath).toBe(join(xdg, 'zed', 'settings.json'));
    expect(existsSync(join(xdg, 'zed', 'settings.json'))).toBe(true);
    expect(existsSync(settingsPath())).toBe(false);
  });
});
