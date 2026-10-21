/**
 * Контракт-тесты адаптера Qwen Code (~/.qwen/settings.json, «one-file setup»).
 *
 * Изоляция — подменой HOME и настоящей переменной инструмента QWEN_HOME.
 *
 * Проверяем: пути, ключ ЛИТЕРАЛОМ в блоке `env` того же файла, записи моделей
 * с реальными лимитами, поэлементную правку общего массива
 * `modelProviders.openai` (чужие записи и КОММЕНТАРИИ целы), правила дефолтной
 * модели (чужой выбор, наша устаревшая, закрытый qwen-oauth, явный --model),
 * отказ без записи и без бэкапа, права 0o600, идемпотентность.
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
import { qwenCodeAdapter, qwenSettingsPath } from './qwen-code.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

const ENV_KEYS = ['HOME', 'QWEN_HOME', 'JOINGONKA_API_KEY'] as const;
const GATE = 'https://gate.joingonka.ai/v1';

let tmpDir: string;
let settingsPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-qwen-'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  settingsPath = join(tmpDir, '.qwen', 'settings.json');
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
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, text);
}
const readSettings = (): any => parseJsonc(readFileSync(settingsPath, 'utf-8'));
const readText = (): string => readFileSync(settingsPath, 'utf-8');
const backups = (): string[] =>
  existsSync(dirname(settingsPath))
    ? readdirSync(dirname(settingsPath)).filter((name) => name.includes('.bak.'))
    : [];
const ours = (settings: any): any[] =>
  (settings.modelProviders?.openai ?? []).filter((m: any) => m.baseUrl === GATE);

describe('qwenCodeAdapter — метаданные', () => {
  it('is a writing JSON adapter for a coding agent', () => {
    expect(qwenCodeAdapter.id).toBe('qwen-code');
    expect(qwenCodeAdapter.format).toBe('json');
    expect(qwenCodeAdapter.apiMode).toBe('openai');
    expect(qwenCodeAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(qwenCodeAdapter.supportsLocalScope).toBeFalsy();
  });
});

describe('qwenCodeAdapter.resolvePath', () => {
  it('defaults to ~/.qwen/settings.json', () => {
    expect(qwenCodeAdapter.resolvePath('user')).toBe(settingsPath);
  });

  it('honours QWEN_HOME (a directory replacing ~/.qwen)', () => {
    process.env.QWEN_HOME = join(tmpDir, 'custom-qwen');
    expect(qwenCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'custom-qwen', 'settings.json'));
  });

  it('expands a leading ~ in QWEN_HOME the way the tool does', () => {
    process.env.QWEN_HOME = '~/elsewhere';
    expect(qwenCodeAdapter.resolvePath('user')).toBe(join(tmpDir, 'elsewhere', 'settings.json'));
  });

  it('uses %USERPROFILE%\\.qwen on Windows', () => {
    expect(qwenSettingsPath({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\.qwen\\settings.json',
    );
  });
});

describe('qwenCodeAdapter.apply — чистая установка', () => {
  it('writes the documented one-file setup', async () => {
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();

    expect(s.env.JOINGONKA_API_KEY).toBe('jg-test123'); // ключ литералом, в родном файле
    expect(s.security.auth.selectedType).toBe('openai');
    expect(s.model.name).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(s.model.baseUrl).toBe(GATE);
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(settingsPath);
    expect(result.backupPath).toBeNull();
  });

  it('declares every model with envKey, our base URL and real limits', async () => {
    await qwenCodeAdapter.apply(input);
    const models = readSettings().modelProviders.openai;
    expect(models.map((m: any) => m.id)).toEqual([
      'MiniMaxAI/MiniMax-M2.7',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'zai-org/GLM-5.3-Flash',
    ]);
    for (const m of models) {
      expect(m.baseUrl).toBe(GATE);
      expect(m.envKey).toBe('JOINGONKA_API_KEY');
      expect(m).not.toHaveProperty('apiKey'); // такого поля в схеме Qwen Code нет
    }
    const deepseek = models[1];
    expect(deepseek.name).toBe('DeepSeek V4 Flash (Gonka)');
    expect(deepseek.generationConfig.contextWindowSize).toBe(380000);
    expect(deepseek.generationConfig.samplingParams.max_tokens).toBe(32768);
    expect(models[0].generationConfig.contextWindowSize).toBe(180000);
    expect(models[2].generationConfig.samplingParams.max_tokens).toBe(8192);
  });

  it('does not invent a $version — the tool stamps it itself on first start', async () => {
    await qwenCodeAdapter.apply(input);
    expect(readSettings()).not.toHaveProperty('$version');
  });

  it.skipIf(platform() === 'win32')('writes the file with mode 0o600', async () => {
    await qwenCodeAdapter.apply(input);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run leaves the file byte-identical', async () => {
    await qwenCodeAdapter.apply(input);
    const first = readText();
    const second = await qwenCodeAdapter.apply(input);
    expect(readText()).toBe(first);
    expect(ours(readSettings())).toHaveLength(3);
    expect(second.backupPath).toMatch(/settings\.json\.bak\./);
  });
});

describe('qwenCodeAdapter.apply — общий массив modelProviders.openai', () => {
  const FOREIGN = `{
  // мои провайдеры — руками
  "env": { "OPENROUTER_API_KEY": "sk-or-mine" },
  "modelProviders": {
    "openai": [
      // OpenRouter — основной
      { "id": "openai/gpt-5.6", "envKey": "OPENROUTER_API_KEY", "baseUrl": "https://openrouter.ai/api/v1" }, // не трогать
      { "id": "local", "baseUrl": "http://localhost:11434/v1" }
    ],
    "anthropic": [{ "id": "claude-opus-5", "envKey": "ANTHROPIC_API_KEY" }]
  },
  "security": { "auth": { "selectedType": "openai" } },
  "model": { "name": "openai/gpt-5.6", "baseUrl": "https://openrouter.ai/api/v1" },
  "ui": { "theme": "Qwen Dark" }
}`;

  it('appends our models and keeps foreign entries, settings and COMMENTS', async () => {
    seed(FOREIGN);
    await qwenCodeAdapter.apply(input);
    const text = readText();
    const s = readSettings();

    expect(text).toContain('// мои провайдеры — руками');
    expect(text).toContain('// OpenRouter — основной');
    expect(text).toContain('// не трогать');
    expect(s.modelProviders.openai[0]).toEqual({
      id: 'openai/gpt-5.6',
      envKey: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(s.modelProviders.openai[1]).toEqual({ id: 'local', baseUrl: 'http://localhost:11434/v1' });
    expect(s.modelProviders.anthropic).toEqual([{ id: 'claude-opus-5', envKey: 'ANTHROPIC_API_KEY' }]);
    expect(s.env.OPENROUTER_API_KEY).toBe('sk-or-mine');
    expect(s.env.JOINGONKA_API_KEY).toBe('jg-test123');
    expect(s.ui.theme).toBe('Qwen Dark');
    expect(ours(s)).toHaveLength(3);
  });

  it('keeps a foreign default model and says how to switch', async () => {
    seed(FOREIGN);
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.model).toEqual({ name: 'openai/gpt-5.6', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(result.messages.join('\n')).toContain('openai/gpt-5.6');
    expect(result.messages.join('\n')).toContain('/model');
  });

  it('replaces our retired entry (Kimi) in place and stays idempotent', async () => {
    seed(
      JSON.stringify(
        {
          modelProviders: {
            openai: [
              { id: 'first-foreign', baseUrl: 'https://a.example/v1' },
              { id: 'moonshotai/Kimi-K2.6', baseUrl: GATE, envKey: 'JOINGONKA_API_KEY' },
              { id: 'last-foreign', baseUrl: 'https://b.example/v1' },
            ],
          },
        },
        null,
        2,
      ),
    );
    await qwenCodeAdapter.apply(input);
    const s = readSettings();
    const ids = s.modelProviders.openai.map((m: any) => m.id);
    expect(ids).not.toContain('moonshotai/Kimi-K2.6');
    expect(ids.slice(0, 3)).toEqual(['first-foreign', 'MiniMaxAI/MiniMax-M2.7', 'last-foreign']);
    expect(ours(s)).toHaveLength(3);

    const once = readText();
    await qwenCodeAdapter.apply(input);
    expect(readText()).toBe(once);
  });

  it('drops surplus retired entries of ours without losing foreign ones', async () => {
    const retired = ['old/a', 'old/b', 'old/c', 'old/d'].map((id) => ({ id, baseUrl: GATE }));
    seed(
      JSON.stringify({
        modelProviders: { openai: [{ id: 'keep-me', baseUrl: 'https://a.example/v1' }, ...retired] },
      }),
    );
    await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.modelProviders.openai[0]).toEqual({ id: 'keep-me', baseUrl: 'https://a.example/v1' });
    expect(ours(s).map((m: any) => m.id)).toEqual([
      'MiniMaxAI/MiniMax-M2.7',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'zai-org/GLM-5.3-Flash',
    ]);
    expect(s.modelProviders.openai).toHaveLength(4);
  });

  it('survives a single-line array (jsonc-parser is fragile there)', async () => {
    seed('{ "modelProviders": { "openai": [{ "id": "x", "baseUrl": "https://a.example/v1" }] } }');
    await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.modelProviders.openai[0]).toEqual({ id: 'x', baseUrl: 'https://a.example/v1' });
    expect(ours(s)).toHaveLength(3);
  });

  it('treats a trailing slash in our base URL as ours', async () => {
    seed(JSON.stringify({ modelProviders: { openai: [{ id: 'old/a', baseUrl: `${GATE}/` }] } }));
    await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.modelProviders.openai).toHaveLength(3);
    expect(s.modelProviders.openai.map((m: any) => m.id)).not.toContain('old/a');
  });
});

describe('qwenCodeAdapter.apply — модель по умолчанию', () => {
  it('resets our retired default (paired with our base URL)', async () => {
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: 'moonshotai/Kimi-K2.6', baseUrl: GATE },
      }),
    );
    await qwenCodeAdapter.apply(input);
    expect(readSettings().model).toEqual({ name: CODING_AGENT_DEFAULT_MODEL, baseUrl: GATE });
  });

  it('resets our retired default written before base URL pairing existed', async () => {
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        modelProviders: { openai: [{ id: 'moonshotai/Kimi-K2.6', baseUrl: GATE }] },
        model: { name: 'moonshotai/Kimi-K2.6' },
      }),
    );
    await qwenCodeAdapter.apply(input);
    expect(readSettings().model.name).toBe(CODING_AGENT_DEFAULT_MODEL);
  });

  it('keeps our own still-served model chosen by the user', async () => {
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: DEFAULT_MODEL, baseUrl: GATE },
      }),
    );
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.model).toEqual({ name: DEFAULT_MODEL, baseUrl: GATE });
    expect(s.security.auth.selectedType).toBe('openai');
    expect(result.messages.join('\n')).not.toMatch(/go back/i); // ничего не переключали
  });

  it('keeps our still-served model but selects the auth type when none was set', async () => {
    // Без selectedType Qwen Code падает на qwen-oauth (закрыт) — связка нерабочая.
    // Тип ставим, а осознанный выбор НАШЕЙ модели на дефолт не меняем.
    seed(JSON.stringify({ model: { name: DEFAULT_MODEL, baseUrl: GATE } }));
    await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.model).toEqual({ name: DEFAULT_MODEL, baseUrl: GATE });
    expect(s.security.auth.selectedType).toBe('openai');
  });

  it('takes over when no auth type is selected, even if a foreign model name is left behind', async () => {
    seed(JSON.stringify({ model: { name: 'qwen3-coder-plus' } }));
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.security.auth.selectedType).toBe('openai');
    expect(s.model).toEqual({ name: CODING_AGENT_DEFAULT_MODEL, baseUrl: GATE });

    const text = result.messages.join('\n');
    expect(text).toContain('qwen3-coder-plus'); // что было
    expect(text).toContain('/auth'); // как вернуть
    expect(text).toMatch(/settings\.json\.bak\./);
  });

  it('does not mistake the same model id on a foreign gateway for ours', async () => {
    // HF-подобные id (`deepseek-ai/…`) продают и другие шлюзы.
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        modelProviders: {
          openai: [{ id: 'moonshotai/Kimi-K2.6', baseUrl: 'https://api.siliconflow.cn/v1' }],
        },
        model: { name: 'moonshotai/Kimi-K2.6', baseUrl: 'https://api.siliconflow.cn/v1' },
      }),
    );
    await qwenCodeAdapter.apply(input);
    expect(readSettings().model).toEqual({
      name: 'moonshotai/Kimi-K2.6',
      baseUrl: 'https://api.siliconflow.cn/v1',
    });
  });

  it('leaves a working foreign auth type alone even without model.name', async () => {
    seed(JSON.stringify({ security: { auth: { selectedType: 'anthropic' } } }));
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.security.auth.selectedType).toBe('anthropic');
    expect(s.model).toBeUndefined();
    expect(result.messages.join('\n')).toContain('/model');
  });

  it('takes over from the discontinued qwen-oauth free tier', async () => {
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'qwen-oauth' } },
        model: { name: 'coder-model' },
      }),
    );
    const result = await qwenCodeAdapter.apply(input);
    const s = readSettings();
    expect(s.security.auth.selectedType).toBe('openai');
    expect(s.model).toEqual({ name: CODING_AGENT_DEFAULT_MODEL, baseUrl: GATE });

    const text = result.messages.join('\n');
    expect(text).toContain('qwen-oauth'); // что было: тип авторизации…
    expect(text).toContain('coder-model'); // …и модель
    expect(text).toContain('2026-04-15'); // почему
    expect(text).toContain('/auth'); // как вернуть
    expect(text).toMatch(/settings\.json\.bak\./);
  });

  it('says nothing about "going back" on a clean install — there is nothing to go back to', async () => {
    const result = await qwenCodeAdapter.apply(input);
    expect(result.messages.join('\n')).not.toMatch(/go back/i);
  });

  it('writes an explicit --model over a foreign default, paired with our base URL', async () => {
    seed(
      JSON.stringify({
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'claude-opus-5', baseUrl: 'https://api.anthropic.com/v1' },
      }),
    );
    const result = await qwenCodeAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    const s = readSettings();
    expect(s.model).toEqual({ name: GLM_MODEL, baseUrl: GATE });
    expect(s.security.auth.selectedType).toBe('openai');

    const text = result.messages.join('\n');
    expect(text).toContain('anthropic');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('/auth');
  });

  it('declares an explicit model that is outside the catalog, with conservative limits', async () => {
    await qwenCodeAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const s = readSettings();
    const extra = s.modelProviders.openai.find((m: any) => m.id === 'vendor/brand-new');
    expect(extra.baseUrl).toBe(GATE);
    expect(extra.generationConfig).toEqual({
      contextWindowSize: 180000,
      samplingParams: { max_tokens: 8192 },
    });
    expect(s.model.name).toBe('vendor/brand-new');
  });
});

describe('qwenCodeAdapter.apply — предупреждения', () => {
  it('warns when a different JOINGONKA_API_KEY in the environment would shadow the file', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-older-key';
    const result = await qwenCodeAdapter.apply(input);
    expect(result.messages.join('\n')).toMatch(/JOINGONKA_API_KEY.*environment/s);
  });

  it('stays quiet when the environment holds the same key (non-interactive install)', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-test123';
    const result = await qwenCodeAdapter.apply(input);
    expect(result.messages.join('\n')).not.toMatch(/shadow|takes precedence/i);
  });
});

describe('qwenCodeAdapter.apply — отказ без записи', () => {
  const refuses = async (text: string) => {
    seed(text);
    await expect(qwenCodeAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readText()).toBe(text);
    expect(backups()).toEqual([]);
  };

  it('refuses an unparsable settings.json', () => refuses('{ "model": '));

  it('refuses a pre-V2 file where "model" is a string (let the tool migrate it first)', () =>
    refuses('{ "model": "gpt-4" }'));

  it('refuses the reverted { protocol, models } wrapper instead of guessing', () =>
    refuses('{ "modelProviders": { "openai": { "protocol": "openai", "models": [] } } }'));

  it('refuses when "env" is not an object', () => refuses('{ "env": [] }'));

  it('refuses a key the tool would mangle by env-substitution', async () => {
    await expect(qwenCodeAdapter.apply({ ...input, apiKey: 'jg-$HOME' })).rejects.toThrow(
      /Nothing was written/,
    );
    expect(existsSync(settingsPath)).toBe(false);
  });
});
