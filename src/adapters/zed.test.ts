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
 * - путь зависит от платформы (Linux — XDG_CONFIG_HOME, macOS — ~/.config,
 *   Windows — %APPDATA%\Zed); битый JSONC → отказ без записи.
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
import { zedAdapter, zedKeyInstructions, zedSettingsPath } from './zed.js';
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
    expect(byName.get('MiniMaxAI/MiniMax-M2.7')?.max_tokens).toBe(200000);
    expect(byName.get('MiniMaxAI/MiniMax-M2.7')?.max_output_tokens).toBe(8192);
    expect(byName.get('zai-org/GLM-5.3-Flash')?.max_tokens).toBe(390000);
    expect(byName.get('zai-org/GLM-5.3-Flash')?.max_output_tokens).toBe(8192);
    expect(byName.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.max_tokens).toBe(380000);
    expect(byName.get('deepseek-ai/DeepSeek-V4-Flash-0731')?.max_output_tokens).toBe(32768);
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

  it('refuses a settings.json it cannot parse and writes nothing', async () => {
    // settings.json — главный конфиг редактора (темы, LSP, кейбинды). Раньше
    // адаптер заменял его свежим документом; теперь отказ без записи.
    const dir = join(tmpDir, '.config', 'zed');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ broken ]');

    await expect(zedAdapter.apply(input())).rejects.toThrow(/Nothing was written/);

    expect(readFileSync(file, 'utf8')).toBe('{ broken ]');
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

describe('zedAdapter.apply — явная модель (0.4.5)', () => {
  it('writes agent.default_model only when --model was given', async () => {
    await zedAdapter.apply(input());
    expect(readConfig().agent).toBeUndefined();

    await zedAdapter.apply({ ...input(), model: 'zai-org/GLM-5.3-Flash', modelExplicit: true });
    expect(readConfig().agent.default_model).toEqual({
      provider: 'joingonka',
      model: 'zai-org/GLM-5.3-Flash',
    });
  });
});

describe('zedSettingsPath — где Zed держит settings.json (0.4.5)', () => {
  // Дока Zed (docs/src/configuring-zed.md, «Settings Files») и исходник
  // crates/paths/src/paths.rs::config_dir, сверено 21.09.2026:
  //   macOS   ~/.config/zed/settings.json            (XDG НЕ учитывается)
  //   Linux   $XDG_CONFIG_HOME/zed/settings.json или ~/.config/zed/settings.json
  //   Windows %APPDATA%\Zed\settings.json
  it('Windows: %APPDATA%\\Zed\\settings.json', () => {
    const path = zedSettingsPath({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      home: 'C:\\Users\\u',
    });
    expect(path).toBe('C:\\Users\\u\\AppData\\Roaming\\Zed\\settings.json');
  });

  it('Windows without APPDATA falls back to the Roaming folder under home', () => {
    const path = zedSettingsPath({ platform: 'win32', env: {}, home: 'C:\\Users\\u' });
    expect(path).toBe('C:\\Users\\u\\AppData\\Roaming\\Zed\\settings.json');
  });

  it('Windows ignores XDG_CONFIG_HOME', () => {
    const path = zedSettingsPath({
      platform: 'win32',
      env: { APPDATA: 'C:\\R', XDG_CONFIG_HOME: 'C:\\xdg' },
      home: 'C:\\Users\\u',
    });
    expect(path).toBe('C:\\R\\Zed\\settings.json');
  });

  it('Linux honours XDG_CONFIG_HOME', () => {
    const ctx = { platform: 'linux' as const, home: '/home/u' };
    expect(zedSettingsPath({ ...ctx, env: {} })).toBe('/home/u/.config/zed/settings.json');
    expect(zedSettingsPath({ ...ctx, env: { XDG_CONFIG_HOME: '/x' } })).toBe('/x/zed/settings.json');
  });

  it('macOS always uses ~/.config/zed — Zed does not read XDG_CONFIG_HOME there', () => {
    const path = zedSettingsPath({
      platform: 'darwin',
      env: { XDG_CONFIG_HOME: '/Users/u/dotfiles' },
      home: '/Users/u',
    });
    expect(path).toBe('/Users/u/.config/zed/settings.json');
  });
});

describe('zedAdapter.apply — ушедшие модели в настройках агента (0.4.5)', () => {
  // Схема Zed (crates/settings_content/src/agent.rs, 21.09.2026): default_model,
  // subagent_model, inline_assistant_model, commit_message_model,
  // thread_summary_model, compaction_model — { provider, model };
  // favorite_models и inline_alternatives — массивы таких же записей.
  const KIMI = 'moonshotai/Kimi-K2.6';

  it('repoints our retired default_model at the requested model', async () => {
    seed(
      [
        '{',
        '  // агент',
        '  "agent": {',
        `    "default_model": { "provider": "joingonka", "model": "${KIMI}", "enable_thinking": true },`,
        '    "commit_message_model": { "provider": "anthropic", "model": "claude-haiku-4-5" }',
        '  }',
        '}',
      ].join('\n'),
    );

    const result = await zedAdapter.apply(input());

    const agent = readConfig().agent;
    // Меняем только model — соседние поля записи целы.
    expect(agent.default_model).toEqual({
      provider: 'joingonka',
      model: DEFAULT_MODEL,
      enable_thinking: true,
    });
    expect(agent.commit_message_model).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(readRawText()).toContain('// агент');
    expect(readRawText()).not.toContain('Kimi');
    expect(result.messages.join('\n')).toMatch(/1 reference.*no longer served/i);
  });

  it('covers the feature-specific models and the model lists', async () => {
    seed(
      JSON.stringify({
        agent: {
          thread_summary_model: { provider: 'joingonka', model: KIMI },
          compaction_model: { provider: 'joingonka', model: 'zai-org/GLM-5.3-Flash' },
          favorite_models: [
            { provider: 'joingonka', model: KIMI },
            { provider: 'openai', model: 'gpt-5.4' },
          ],
          inline_alternatives: [{ provider: 'joingonka', model: KIMI }],
        },
      }),
    );

    await zedAdapter.apply(input());

    const agent = readConfig().agent;
    expect(agent.thread_summary_model.model).toBe(DEFAULT_MODEL);
    expect(agent.compaction_model.model).toBe('zai-org/GLM-5.3-Flash'); // актуальная — цела
    expect(agent.favorite_models).toEqual([{ provider: 'openai', model: 'gpt-5.4' }]);
    expect(agent.inline_alternatives).toEqual([]);
  });

  it('leaves a foreign provider alone even when the model name looks unknown', async () => {
    seed(JSON.stringify({ agent: { default_model: { provider: 'openai', model: KIMI } } }));

    const result = await zedAdapter.apply(input());

    expect(readConfig().agent.default_model).toEqual({ provider: 'openai', model: KIMI });
    expect(result.messages.join('\n')).not.toMatch(/no longer served/i);
  });
});

describe('zedAdapter.apply — неожиданная форма узла (0.4.5)', () => {
  it('refuses when `language_models` is not an object: no write, no backup', async () => {
    const original = '{\n  // my theme\n  "theme": "Ayu Dark",\n  "language_models": false\n}';
    seed(original);

    await expect(zedAdapter.apply(input())).rejects.toThrow(
      /settings\.json.*"language_models" is a boolean.*Nothing was written/s,
    );

    expect(readRawText()).toBe(original);
    expect(readdirSync(join(tmpDir, '.config', 'zed'))).toEqual(['settings.json']);
  });
});

describe('zedKeyInstructions — как передать ключ Zed на разных платформах (0.5.0)', () => {
  // Ключ в settings.json класть нельзя, поэтому адаптер печатает, как задать
  // переменную окружения. До 0.5.0 на Windows печатался POSIX-овый `export`,
  // которого нет ни в PowerShell, ни в cmd.
  const ctx = (platform: NodeJS.Platform) => ({ platform, env: {}, home: '/home/u' });

  it('prints `export` for POSIX shells (Linux, macOS)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const text = zedKeyInstructions('jg-test123', ctx(platform)).join('\n');
      expect(text).toContain('export JOINGONKA_API_KEY=jg-test123');
      expect(text).not.toContain('setx');
      expect(text).not.toContain('$env:');
    }
  });

  it('prints PowerShell `$env:` for the session and `setx` for a permanent variable on Windows', () => {
    const text = zedKeyInstructions('jg-test123', ctx('win32')).join('\n');
    expect(text).toContain('$env:JOINGONKA_API_KEY = "jg-test123"');
    expect(text).toContain('setx JOINGONKA_API_KEY "jg-test123"');
    // `export` на Windows не работает — его в тексте быть не должно.
    expect(text).not.toMatch(/\bexport\b/);
    // setx не меняет уже открытые окна — об этом сказано прямо.
    expect(text).toMatch(/started afterwards|new terminal/i);
  });

  it('offers the UI key store on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const text = zedKeyInstructions('jg-test123', ctx(platform)).join('\n');
      expect(text).toContain('LLM Providers');
      expect(text).toContain('"joingonka" provider');
    }
  });

  it('apply() uses the instructions of the platform it runs on', async () => {
    const { messages } = await zedAdapter.apply(input());
    const expected = zedKeyInstructions('jg-test123');
    expect(messages.join('\n')).toContain(expected.join('\n'));
  });
});
