/**
 * Тесты адаптера GitHub Copilot BYOK (instructions-only, три клиента).
 *
 * Адаптер печатает три раздела — VS Code (Custom Endpoint), Copilot CLI
 * (переменные окружения) и JetBrains (Manage Models). Файл не пишем: ключ у
 * VS Code живёт только в secret storage, у CLI — только в env.
 *
 * Проверяем: resolvePath→null, wrote:false; новый путь UI вместо устаревшего
 * («Model Providers» / провайдер «OpenAI Compatible»); JSON-блок моделей для
 * chatLanguageModels.json разбирается и несёт РЕАЛЬНЫЕ лимиты каталога; блок
 * export для CLI — с литеральными значениями; нет неподтверждённых докой
 * утверждений «нужен Pro / public preview»; в tmp-HOME ничего не появляется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotByokAdapter } from './copilot-byok.js';
import {
  DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  GLM_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
} from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-copilot-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = { apiKey: 'jg-test123', model: DEFAULT_MODEL, scope: 'user' as const };

/** Запись модели в том виде, в каком её ждёт chatLanguageModels.json. */
interface VscodeModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * Достаёт из сообщений напечатанный фрагмент `"models": [ … ]` и разбирает его
 * как JSON. Если блок нельзя вставить в файл как есть — тест падает здесь.
 */
function extractVscodeModels(messages: string[]): VscodeModel[] {
  const start = messages.findIndex((line) => line === '  "models": [');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = messages.findIndex((line, i) => i > start && line === '  ]');
  expect(end).toBeGreaterThan(start);
  const fragment = messages.slice(start, end + 1).join('\n');
  return (JSON.parse(`{${fragment}}`) as { models: VscodeModel[] }).models;
}

describe('copilotByokAdapter', () => {
  it('is instructions-only: resolvePath null, wrote false, no paths', async () => {
    expect(copilotByokAdapter.id).toBe('copilot-byok');
    expect(copilotByokAdapter.format).toBe('instructions');
    expect(copilotByokAdapter.resolvePath('user')).toBeNull();
    expect(copilotByokAdapter.resolvePath('local')).toBeNull();
    const result = await copilotByokAdapter.apply(input);
    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
  });

  it('prints three sections: VS Code, Copilot CLI, JetBrains', async () => {
    const { messages } = await copilotByokAdapter.apply(input);
    const headers = messages.filter((line) => /^\[\d\/3\]/.test(line));
    expect(headers).toHaveLength(3);
    expect(headers[0]).toContain('VS Code');
    expect(headers[1]).toContain('Copilot CLI');
    expect(headers[2]).toContain('JetBrains');
  });

  it('VS Code: leads through the Custom Endpoint path, not the deprecated one', async () => {
    const joined = (await copilotByokAdapter.apply(input)).messages.join('\n');
    expect(joined).toContain('Chat: Manage Language Models');
    expect(joined).toContain('Add Models');
    expect(joined).toContain('Custom Endpoint');
    expect(joined).toContain('Chat Completions');
    expect(joined).toContain('chatLanguageModels.json');
    expect(joined).toContain('jg-test123');
    // Устаревший путь и тип провайдера из прежней версии адаптера
    expect(joined).not.toContain('Model Providers');
    expect(joined).not.toContain('Provider type');
  });

  it('VS Code: the printed "models" block is valid JSON with the full endpoint URL', async () => {
    const models = extractVscodeModels((await copilotByokAdapter.apply(input)).messages);
    // Весь каталог сети, выбранная модель — первой
    expect(models.map((m) => m.id).sort()).toEqual(OPENCLAW_MODELS.map((m) => m.id).sort());
    expect(models[0]!.id).toBe(DEFAULT_MODEL);
    for (const m of models) {
      // Док VS Code: «provide the full endpoint URL including the API path»
      expect(m.url).toBe('https://gate.joingonka.ai/v1/chat/completions');
      // Без toolCalling модель не попадает в пикер агентного режима
      expect(m.toolCalling).toBe(true);
      // Картинок на вход у моделей сети нет
      expect(m.vision).toBe(false);
    }
  });

  it('VS Code: per-model limits come from the catalog (input = context − output)', async () => {
    const models = extractVscodeModels((await copilotByokAdapter.apply(input)).messages);
    for (const spec of OPENCLAW_MODELS) {
      const entry = models.find((m) => m.id === spec.id)!;
      const context = spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW;
      expect(entry.maxOutputTokens).toBe(spec.maxTokens);
      // Док VS Code: сумма двух полей не должна превышать контекстное окно
      expect(entry.maxInputTokens + entry.maxOutputTokens).toBe(context);
    }
    // Контрольные числа — чтобы формула не «позеленела» вместе с ошибкой в ней
    expect(models.find((m) => m.id === DEFAULT_MODEL)!.maxInputTokens).toBe(171808);
    expect(models.find((m) => m.id === DEEPSEEK_MODEL)!.maxInputTokens).toBe(347232);
    expect(models.find((m) => m.id === DEEPSEEK_MODEL)!.maxOutputTokens).toBe(32768);
    expect(models.find((m) => m.id === GLM_MODEL)!.maxInputTokens).toBe(381808);
  });

  it('Copilot CLI: prints an export block with literal values', async () => {
    const { messages } = await copilotByokAdapter.apply(input);
    expect(messages).toContain('  export COPILOT_PROVIDER_BASE_URL=https://gate.joingonka.ai/v1');
    expect(messages).toContain('  export COPILOT_PROVIDER_TYPE=openai');
    expect(messages).toContain('  export COPILOT_PROVIDER_API_KEY=jg-test123');
    expect(messages).toContain(`  export COPILOT_MODEL=${DEFAULT_MODEL}`);
    expect(messages).toContain('  export COPILOT_PROVIDER_MAX_PROMPT_TOKENS=171808');
    expect(messages).toContain('  export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=8192');
    // Глобальные env за пользователя не персистим — и говорим об этом прямо
    expect(messages.join('\n')).toContain('shell profile');
  });

  it('Copilot CLI: limits follow the selected model', async () => {
    const deepseek = await copilotByokAdapter.apply({ ...input, model: DEEPSEEK_MODEL });
    expect(deepseek.messages).toContain(`  export COPILOT_MODEL=${DEEPSEEK_MODEL}`);
    expect(deepseek.messages).toContain('  export COPILOT_PROVIDER_MAX_PROMPT_TOKENS=347232');
    expect(deepseek.messages).toContain('  export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=32768');

    const glm = await copilotByokAdapter.apply({ ...input, model: GLM_MODEL });
    expect(glm.messages).toContain('  export COPILOT_PROVIDER_MAX_PROMPT_TOKENS=381808');
    expect(glm.messages).toContain('  export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=8192');
  });

  it('JetBrains: Manage Models path with base URL /v1, key and model', async () => {
    const { messages } = await copilotByokAdapter.apply(input);
    const from = messages.findIndex((line) => line.startsWith('[3/3]'));
    const section = messages.slice(from).join('\n');
    expect(section).toContain('Manage Models');
    expect(section).toContain('Add Models');
    expect(section).toContain('https://gate.joingonka.ai/v1');
    expect(section).toContain('jg-test123');
    expect(section).toContain(DEFAULT_MODEL);
  });

  it('prints the real limits of the selected model', async () => {
    const minimax = (await copilotByokAdapter.apply(input)).messages.join('\n');
    expect(minimax).toContain('context window 180000');
    expect(minimax).toContain('max output 8192');

    const deepseek = (
      await copilotByokAdapter.apply({ ...input, model: DEEPSEEK_MODEL })
    ).messages.join('\n');
    expect(deepseek).toContain('context window 380000');
    expect(deepseek).toContain('max output 32768');
  });

  it('makes no plan claims the docs do not back, but names the admin policy', async () => {
    const joined = (await copilotByokAdapter.apply(input)).messages.join('\n');
    expect(joined).not.toMatch(/Requires a Copilot Pro/i);
    expect(joined).not.toMatch(/public preview/i);
    // Док VS Code: BYOK работает без аккаунта GitHub и без плана Copilot
    expect(joined).toContain('without a GitHub account');
    // Business/Enterprise — политика администратора (доки VS Code и GitHub)
    expect(joined).toContain('Bring Your Own Language Model Key');
    // Ценностное сообщение: BYOK не расходует квоту запросов Copilot
    expect(joined).toContain('request quota');
  });

  it('keeps working for a model id outside the catalog (conservative limits)', async () => {
    const custom = 'acme/brand-new-model';
    const { messages } = await copilotByokAdapter.apply({ ...input, model: custom });
    const models = extractVscodeModels(messages);
    expect(models[0]!.id).toBe(custom);
    // Остальной каталог никуда не девается
    expect(models).toHaveLength(OPENCLAW_MODELS.length + 1);
    // Консервативные значения: наименьшие по каталогу окно и потолок выдачи
    const minOutput = Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens));
    expect(models[0]!.maxOutputTokens).toBe(minOutput);
    expect(models[0]!.maxInputTokens + models[0]!.maxOutputTokens).toBe(OPENCLAW_CONTEXT_WINDOW);
    expect(messages).toContain(`  export COPILOT_MODEL=${custom}`);
    // Честно говорим, что лимиты не из каталога
    expect(messages.join('\n')).toContain("not in this installer's catalog");
  });

  it('creates no files in the tmp HOME', async () => {
    await copilotByokAdapter.apply(input);
    expect(readdirSync(tmpDir).length).toBe(0);
  });
});
