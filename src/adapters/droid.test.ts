/**
 * Контракт-тесты адаптера Factory Droid (~/.factory/settings.json, BYOK).
 *
 * Переменной для переноса каталога у Droid нет — изоляция подменой HOME.
 *
 * Проверяем: путь, записи `customModels` (ключ литералом, реальные лимиты,
 * явный id), поэлементную правку общего массива (чужие записи и КОММЕНТАРИИ
 * целы), дефолт в `sessionDefaultSettings.model` и правила его смены (в том
 * числе распознавание НАШЕЙ записи по автогенерируемому id Droid), отказ без
 * записи и без бэкапа, права 0o600, идемпотентность.
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
import { droidAdapter, droidSettingsPath } from './droid.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

const GATE = 'https://gate.joingonka.ai/v1';
const OUR_DEFAULT = `custom:${CODING_AGENT_DEFAULT_MODEL}`;

let tmpDir: string;
let settingsPath: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-droid-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpDir;
  settingsPath = join(tmpDir, '.factory', 'settings.json');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
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
  (settings.customModels ?? []).filter((m: any) => m.baseUrl === GATE);

describe('droidAdapter — метаданные', () => {
  it('is a writing JSON adapter for a coding agent', () => {
    expect(droidAdapter.id).toBe('droid');
    expect(droidAdapter.format).toBe('json');
    expect(droidAdapter.apiMode).toBe('openai');
    expect(droidAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(droidAdapter.supportsLocalScope).toBeFalsy();
  });
});

describe('droidAdapter.resolvePath', () => {
  it('is ~/.factory/settings.json', () => {
    expect(droidAdapter.resolvePath('user')).toBe(settingsPath);
  });

  it('is %USERPROFILE%\\.factory\\settings.json on Windows', () => {
    expect(droidSettingsPath({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\.factory\\settings.json',
    );
  });
});

describe('droidAdapter.apply — чистая установка', () => {
  it('writes the BYOK catalog with a literal key and real limits', async () => {
    const result = await droidAdapter.apply(input);
    const models = readSettings().customModels;

    expect(models.map((m: any) => m.model)).toEqual([
      'MiniMaxAI/MiniMax-M2.7',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'zai-org/GLM-5.3-Flash',
    ]);
    expect(models[1]).toEqual({
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      id: 'custom:deepseek-ai/DeepSeek-V4-Flash-0731',
      displayName: 'DeepSeek V4 Flash (Gonka)',
      baseUrl: GATE,
      apiKey: 'jg-test123', // литерал, не ${VAR}
      provider: 'generic-chat-completion-api',
      maxOutputTokens: 32768,
      maxContextLimit: 380000,
      noImageSupport: true,
    });
    expect(models[0].maxContextLimit).toBe(180000);
    expect(models[2].maxOutputTokens).toBe(8192);
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(settingsPath);
    expect(result.backupPath).toBeNull();
  });

  it('sets the default in sessionDefaultSettings.model — the key the CLI reads', async () => {
    const result = await droidAdapter.apply(input);
    const s = readSettings();
    expect(s.sessionDefaultSettings.model).toBe(OUR_DEFAULT);
    expect(s).not.toHaveProperty('model'); // устаревший ключ верхнего уровня не пишем
    expect(result.messages.join('\n')).toContain(OUR_DEFAULT);
  });

  it.skipIf(platform() === 'win32')('writes the file with mode 0o600', async () => {
    await droidAdapter.apply(input);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run leaves the file byte-identical', async () => {
    await droidAdapter.apply(input);
    const first = readText();
    const second = await droidAdapter.apply(input);
    expect(readText()).toBe(first);
    expect(ours(readSettings())).toHaveLength(3);
    expect(second.backupPath).toMatch(/settings\.json\.bak\./);
  });
});

describe('droidAdapter.apply — golden: формат файла закреплён', () => {
  // ★ Формат подтверждён не только докой, но и строками бинарника CLI 0.223.0
  // (см. шапку droid.ts): имена ключей, их место в корне файла и вид id. Любая
  // правка адаптера, меняющая хоть символ этого файла, должна быть осознанной —
  // Droid молча игнорирует незнакомые ключи, и ошибка формата выглядит как
  // «модель не появилась», а не как падение.
  const GOLDEN = `{
  "customModels": [
    {
      "model": "MiniMaxAI/MiniMax-M2.7",
      "id": "custom:MiniMaxAI/MiniMax-M2.7",
      "displayName": "MiniMax M2.7 (Gonka)",
      "baseUrl": "https://gate.joingonka.ai/v1",
      "apiKey": "jg-test123",
      "provider": "generic-chat-completion-api",
      "maxOutputTokens": 8192,
      "maxContextLimit": 180000,
      "noImageSupport": true
    },
    {
      "model": "deepseek-ai/DeepSeek-V4-Flash-0731",
      "id": "custom:deepseek-ai/DeepSeek-V4-Flash-0731",
      "displayName": "DeepSeek V4 Flash (Gonka)",
      "baseUrl": "https://gate.joingonka.ai/v1",
      "apiKey": "jg-test123",
      "provider": "generic-chat-completion-api",
      "maxOutputTokens": 32768,
      "maxContextLimit": 380000,
      "noImageSupport": true
    },
    {
      "model": "zai-org/GLM-5.3-Flash",
      "id": "custom:zai-org/GLM-5.3-Flash",
      "displayName": "GLM 5.3 Flash (Gonka)",
      "baseUrl": "https://gate.joingonka.ai/v1",
      "apiKey": "jg-test123",
      "provider": "generic-chat-completion-api",
      "maxOutputTokens": 8192,
      "maxContextLimit": 390000,
      "noImageSupport": true
    }
  ],
  "sessionDefaultSettings": {
    "model": "custom:deepseek-ai/DeepSeek-V4-Flash-0731"
  }
}
`;

  it('writes exactly this settings.json on a clean install', async () => {
    await droidAdapter.apply(input);
    expect(readText()).toBe(GOLDEN);
  });

  it('writes exactly this when only the default model is switched by --model', async () => {
    await droidAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    expect(readText()).toBe(
      GOLDEN.replace(
        '"model": "custom:deepseek-ai/DeepSeek-V4-Flash-0731"\n  }',
        '"model": "custom:zai-org/GLM-5.3-Flash"\n  }',
      ),
    );
  });
});

describe('droidAdapter.apply — общий массив customModels', () => {
  const FOREIGN = `{
  // мои настройки Droid
  "sessionDefaultSettings": { "model": "claude-opus-4-7", "autonomyLevel": "low" },
  "customModels": [
    // локальная модель — не трогать
    { "model": "qwen3:32b", "displayName": "Local Qwen", "baseUrl": "http://localhost:11434/v1", "provider": "generic-chat-completion-api" }, // хвост
    { "model": "openai/gpt-oss-120b", "displayName": "OSS [OpenRouter]", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-mine", "provider": "generic-chat-completion-api" }
  ],
  "diffMode": "github"
}`;

  it('appends our models and keeps foreign entries, settings and COMMENTS', async () => {
    seed(FOREIGN);
    await droidAdapter.apply(input);
    const text = readText();
    const s = readSettings();

    expect(text).toContain('// мои настройки Droid');
    expect(text).toContain('// локальная модель — не трогать');
    expect(text).toContain('// хвост');
    expect(s.customModels[0]).toEqual({
      model: 'qwen3:32b',
      displayName: 'Local Qwen',
      baseUrl: 'http://localhost:11434/v1',
      provider: 'generic-chat-completion-api',
    });
    expect(s.customModels[1].apiKey).toBe('sk-or-mine');
    expect(s.diffMode).toBe('github');
    expect(s.sessionDefaultSettings.autonomyLevel).toBe('low');
    expect(ours(s)).toHaveLength(3);
  });

  it('keeps a Factory-managed default model and says how to switch', async () => {
    seed(FOREIGN);
    const result = await droidAdapter.apply(input);
    expect(readSettings().sessionDefaultSettings.model).toBe('claude-opus-4-7');
    expect(result.messages.join('\n')).toContain('claude-opus-4-7');
    expect(result.messages.join('\n')).toContain('/model');
  });

  it('keeps a default that points at a FOREIGN custom model (auto-generated id)', async () => {
    seed(
      JSON.stringify({
        sessionDefaultSettings: { model: 'custom:Local-Qwen-0' },
        customModels: [
          { model: 'qwen3:32b', displayName: 'Local Qwen', baseUrl: 'http://localhost:11434/v1', provider: 'generic-chat-completion-api' },
        ],
      }),
    );
    await droidAdapter.apply(input);
    expect(readSettings().sessionDefaultSettings.model).toBe('custom:Local-Qwen-0');
  });

  it('respects a default set through the legacy top-level "model" key', async () => {
    seed(JSON.stringify({ model: 'gpt-5.6-sol' }));
    await droidAdapter.apply(input);
    const s = readSettings();
    expect(s.model).toBe('gpt-5.6-sol');
    expect(s.sessionDefaultSettings).toBeUndefined();
  });

  it('replaces our retired entry (Kimi) in place and resets the retired default', async () => {
    seed(
      JSON.stringify(
        {
          sessionDefaultSettings: { model: 'custom:moonshotai/Kimi-K2.6' },
          customModels: [
            { model: 'a', baseUrl: 'https://a.example/v1', provider: 'generic-chat-completion-api' },
            {
              model: 'moonshotai/Kimi-K2.6',
              id: 'custom:moonshotai/Kimi-K2.6',
              displayName: 'Kimi K2.6 (Gonka)',
              baseUrl: GATE,
              apiKey: 'jg-old',
              provider: 'generic-chat-completion-api',
            },
            { model: 'b', baseUrl: 'https://b.example/v1', provider: 'generic-chat-completion-api' },
          ],
        },
        null,
        2,
      ),
    );
    await droidAdapter.apply(input);
    const s = readSettings();
    const models = s.customModels.map((m: any) => m.model);
    expect(models).not.toContain('moonshotai/Kimi-K2.6');
    expect(models.slice(0, 3)).toEqual(['a', 'MiniMaxAI/MiniMax-M2.7', 'b']);
    expect(ours(s)).toHaveLength(3);
    expect(readText()).not.toContain('jg-old');
    expect(s.sessionDefaultSettings.model).toBe(OUR_DEFAULT);
  });

  it('recognises OUR entry behind an id Droid generated itself and re-points the default', async () => {
    // Человек настроил шлюз руками по доке BYOK: без id, своё displayName. Droid
    // сам дал записи id `custom:<DisplayName>-<n>` и сохранил его как дефолт.
    // Наши записи получают явные id — старый дефолт иначе повис бы в воздухе,
    // и Droid молча ушёл бы на платную модель Factory.
    seed(
      JSON.stringify({
        sessionDefaultSettings: { model: 'custom:My-Gonka-MiniMax-0' },
        customModels: [
          { model: DEFAULT_MODEL, displayName: 'My Gonka MiniMax', baseUrl: `${GATE}/`, apiKey: 'jg-old', provider: 'generic-chat-completion-api' },
        ],
      }),
    );
    await droidAdapter.apply(input);
    const s = readSettings();
    expect(s.sessionDefaultSettings.model).toBe(`custom:${DEFAULT_MODEL}`);
    expect(ours(s)).toHaveLength(3);
  });

  it('numbers duplicate display names the way Droid does (per name, not per position)', async () => {
    seed(
      JSON.stringify({
        sessionDefaultSettings: { model: 'custom:Same-Name-1' },
        customModels: [
          { model: 'x', displayName: 'Same Name', baseUrl: 'https://a.example/v1', provider: 'openai' },
          { model: 'other', displayName: 'Other', baseUrl: 'https://c.example/v1', provider: 'openai' },
          { model: 'moonshotai/Kimi-K2.6', displayName: 'Same Name', baseUrl: GATE, provider: 'generic-chat-completion-api' },
        ],
      }),
    );
    await droidAdapter.apply(input);
    // `custom:Same-Name-1` — это НАША устаревшая запись (вторая с таким именем).
    expect(readSettings().sessionDefaultSettings.model).toBe(OUR_DEFAULT);
  });

  it('drops surplus retired entries of ours without losing foreign ones', async () => {
    const retired = ['old/a', 'old/b', 'old/c', 'old/d'].map((model) => ({
      model,
      baseUrl: GATE,
      provider: 'generic-chat-completion-api',
    }));
    const foreign = { model: 'keep-me', baseUrl: 'https://a.example/v1', provider: 'openai' };
    seed(JSON.stringify({ customModels: [foreign, ...retired] }));
    await droidAdapter.apply(input);
    const s = readSettings();
    expect(s.customModels[0]).toEqual(foreign);
    expect(s.customModels).toHaveLength(4);
    expect(ours(s)).toHaveLength(3);
  });

  it('survives a single-line array (jsonc-parser is fragile there)', async () => {
    seed('{ "customModels": [{ "model": "x", "baseUrl": "https://a.example/v1", "provider": "openai" }] }');
    await droidAdapter.apply(input);
    const s = readSettings();
    expect(s.customModels[0]).toEqual({ model: 'x', baseUrl: 'https://a.example/v1', provider: 'openai' });
    expect(ours(s)).toHaveLength(3);
  });
});

describe('droidAdapter.apply — явная модель', () => {
  it('writes an explicit --model over a Factory-managed default', async () => {
    seed(JSON.stringify({ sessionDefaultSettings: { model: 'claude-opus-4-7', reasoningEffort: 'high' } }));
    await droidAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    const s = readSettings();
    expect(s.sessionDefaultSettings.model).toBe(`custom:${GLM_MODEL}`);
    expect(s.sessionDefaultSettings.reasoningEffort).toBe('high'); // соседний ключ цел
  });

  it('keeps our own still-served model chosen by the user', async () => {
    seed(JSON.stringify({ sessionDefaultSettings: { model: `custom:${DEFAULT_MODEL}` } }));
    await droidAdapter.apply(input);
    expect(readSettings().sessionDefaultSettings.model).toBe(`custom:${DEFAULT_MODEL}`);
  });

  it('declares an explicit model that is outside the catalog, with conservative limits', async () => {
    await droidAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const s = readSettings();
    const extra = s.customModels.find((m: any) => m.model === 'vendor/brand-new');
    expect(extra.id).toBe('custom:vendor/brand-new');
    expect(extra.maxOutputTokens).toBe(8192);
    expect(extra.maxContextLimit).toBe(180000);
    expect(s.sessionDefaultSettings.model).toBe('custom:vendor/brand-new');
  });
});

describe('droidAdapter.apply — отказ без записи', () => {
  const refuses = async (text: string) => {
    seed(text);
    await expect(droidAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readText()).toBe(text);
    expect(backups()).toEqual([]);
  };

  it('refuses an unparsable settings.json', () => refuses('{ "customModels": [ '));
  it('refuses when "customModels" is not an array', () => refuses('{ "customModels": {} }'));
  it('refuses when "sessionDefaultSettings" is not an object', () =>
    refuses('{ "sessionDefaultSettings": "auto" }'));

  it('refuses a key Droid would treat as an environment reference', async () => {
    await expect(droidAdapter.apply({ ...input, apiKey: 'jg-${HOME}' })).rejects.toThrow(
      /Nothing was written/,
    );
    expect(existsSync(settingsPath)).toBe(false);
  });
});
