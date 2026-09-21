/**
 * Тесты адаптера omp (Oh My Pi, https://github.com/can1357/oh-my-pi).
 *
 * Формат сверен с первоисточником 21.09.2026 (omp 18.2.8, docs/models.md,
 * docs/settings.md, packages/coding-agent/src/config/models-config-schema-bundle.ts):
 *   - ~/.omp/agent/models.yml → providers.<id> = { baseUrl, api, apiKey, models[] };
 *   - ~/.omp/agent/config.yml → modelRoles.default = "<provider>/<modelId>".
 *
 * Проверяем:
 * - блок провайдера: baseUrl С /v1, api=openai-completions, ключ ЛИТЕРАЛОМ, 0o600;
 * - каталог наших моделей пересобирается целиком с реальными лимитами, посеянная
 *   устаревшая Kimi исчезает; запись модели не выходит за схему omp (гейт дрейфа);
 * - чужие провайдеры, чужие поля внутри нашего блока и КОММЕНТАРИИ целы;
 * - битый YAML / корень-не-map → отказ «Nothing was written», ни записи, ни бэкапа;
 *   текст ошибки не содержит фрагмента файла (там может лежать чужой ключ);
 * - дефолтная модель: явная — всегда; иначе чужой выбор и наша актуальная модель
 *   не трогаются, пустое и наше устаревшее — заменяются;
 * - пути: PI_CODING_AGENT_DIR, PI_CONFIG_DIR, профили OMP_PROFILE/PI_PROFILE,
 *   запасное имя models.yaml, наследный models.json не теряется;
 * - идемпотентность повторного apply (байт-в-байт).
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
import { parse } from 'yaml';
import { ompAdapter, ompAgentDir } from './omp.js';
import type { ApplyInput } from './types.js';
import {
  CODING_AGENT_DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  DEFAULT_MODEL,
  GLM_MODEL,
  OPENCLAW_MODELS,
  piModelEntry,
} from '../constants.js';

/** Переменные окружения, влияющие на пути omp, — изолируем каждую. */
const ENV_KEYS = ['HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE'];

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-omp-test-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (overrides: Partial<ApplyInput> = {}): ApplyInput => ({
  apiKey: 'jg-test123',
  model: CODING_AGENT_DEFAULT_MODEL,
  scope: 'user',
  ...overrides,
});

const agentDir = () => join(tmpDir, '.omp', 'agent');
const modelsPath = () => join(agentDir(), 'models.yml');
const configPath = () => join(agentDir(), 'config.yml');

const readYaml = (path: string) => parse(readFileSync(path, 'utf-8')) as Record<string, any>;

/** Создать файл внутри каталога агента. */
const seed = (name: string, text: string) => {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), name), text);
};

const backupsOf = (name: string) =>
  existsSync(agentDir()) ? readdirSync(agentDir()).filter((f) => f.startsWith(`${name}.bak.`)) : [];

describe('ompAdapter — shape', () => {
  it('is a YAML-writing OpenAI-mode adapter with the coding-agent default model', () => {
    expect(ompAdapter.id).toBe('omp');
    expect(ompAdapter.format).toBe('yaml');
    expect(ompAdapter.apiMode).toBe('openai');
    expect(ompAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(ompAdapter.supportsLocalScope).toBeFalsy();
    expect(ompAdapter.label).toMatch(/omp|Oh My Pi/i);
  });
});

describe('ompAdapter.resolvePath', () => {
  it('defaults to ~/.omp/agent/models.yml', () => {
    expect(ompAdapter.resolvePath('user')).toBe(modelsPath());
  });

  it('honours PI_CODING_AGENT_DIR (полная замена каталога агента)', () => {
    const custom = join(tmpDir, 'portable-agent');
    process.env.PI_CODING_AGENT_DIR = custom;
    expect(ompAdapter.resolvePath('user')).toBe(join(custom, 'models.yml'));
  });

  it('honours PI_CONFIG_DIR (имя корневого каталога в HOME)', () => {
    process.env.PI_CONFIG_DIR = '.omp-dev';
    expect(ompAdapter.resolvePath('user')).toBe(join(tmpDir, '.omp-dev', 'agent', 'models.yml'));
  });

  it('именованный профиль уезжает в profiles/<имя> и игнорирует PI_CODING_AGENT_DIR', () => {
    process.env.OMP_PROFILE = 'work';
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, 'ignored');
    expect(ompAdapter.resolvePath('user')).toBe(
      join(tmpDir, '.omp', 'profiles', 'work', 'agent', 'models.yml'),
    );
  });

  it('пустой OMP_PROFILE выбирает профиль по умолчанию и перекрывает PI_PROFILE', () => {
    process.env.OMP_PROFILE = '';
    process.env.PI_PROFILE = 'legacy';
    expect(ompAdapter.resolvePath('user')).toBe(modelsPath());
  });

  it('PI_PROFILE — наследный запасной вариант имени профиля', () => {
    process.env.PI_PROFILE = 'legacy';
    expect(ompAdapter.resolvePath('user')).toBe(
      join(tmpDir, '.omp', 'profiles', 'legacy', 'agent', 'models.yml'),
    );
  });

  it('rejects an invalid profile name instead of writing to a wrong place', async () => {
    process.env.OMP_PROFILE = '../evil';
    await expect(ompAdapter.apply(input())).rejects.toThrow(/profile/i);
    expect(existsSync(join(tmpDir, '.omp'))).toBe(false);
  });

  it('uses an existing models.yaml when models.yml is absent (запасное имя omp)', () => {
    seed('models.yaml', 'providers: {}\n');
    expect(ompAdapter.resolvePath('user')).toBe(join(agentDir(), 'models.yaml'));
  });
});

describe('ompAdapter.apply — provider block (models.yml)', () => {
  it('writes providers.joingonka with baseUrl WITH /v1, api and the literal key', async () => {
    const result = await ompAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(modelsPath());

    const provider = readYaml(modelsPath()).providers.joingonka;
    expect(provider.baseUrl).toBe('https://gate.joingonka.ai/v1');
    expect(provider.api).toBe('openai-completions');
    expect(provider.apiKey).toBe('jg-test123');
  });

  it('writes the whole catalog with REAL context and output limits', async () => {
    await ompAdapter.apply(input());
    const models = readYaml(modelsPath()).providers.joingonka.models as any[];
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));

    expect(Object.keys(byId).sort()).toEqual([DEEPSEEK_MODEL, DEFAULT_MODEL, GLM_MODEL].sort());
    expect(byId[DEFAULT_MODEL].contextWindow).toBe(200000);
    expect(byId[DEFAULT_MODEL].maxTokens).toBe(8192);
    expect(byId[DEEPSEEK_MODEL].contextWindow).toBe(380000);
    expect(byId[DEEPSEEK_MODEL].maxTokens).toBe(32768);
    expect(byId[DEEPSEEK_MODEL].reasoning).toBe(true);
    expect(byId[GLM_MODEL].contextWindow).toBe(390000);
    expect(byId[GLM_MODEL].maxTokens).toBe(8192);
    expect(byId[GLM_MODEL].reasoning).toBe(true);
    expect(byId[DEFAULT_MODEL].reasoning).toBeUndefined();
  });

  it('гейт дрейфа: запись модели не выходит за схему omp (ModelDefinitionSchema)', async () => {
    // Схема omp строгая: лишнее поле = весь models.yml отвергнут. Запись собирает
    // общий piModelEntry — если в него добавят Pi-специфичное поле, тест покраснеет.
    const allowed = ['id', 'name', 'input', 'contextWindow', 'maxTokens', 'cost', 'reasoning'];
    await ompAdapter.apply(input());
    for (const model of readYaml(modelsPath()).providers.joingonka.models as any[]) {
      for (const key of Object.keys(model)) expect(allowed).toContain(key);
      // cost в схеме omp — все четыре числа обязательны, если блок задан.
      expect(Object.keys(model.cost).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
      expect(model.input).toEqual(['text']);
    }
  });

  it('asks the orchestrator for live prices and writes them into `cost`', async () => {
    expect(ompAdapter.wantsPricing).toBe(true);

    await ompAdapter.apply(input({ pricing: { input: 0.005808, output: 0.017424 } }));

    for (const model of readYaml(modelsPath()).providers.joingonka.models as any[]) {
      expect(model.cost).toEqual({
        input: 0.005808,
        output: 0.017424,
        cacheRead: 0.005808,
        cacheWrite: 0.005808,
      });
    }
  });

  it('prefers a per-model live price when prices differ', async () => {
    await ompAdapter.apply(
      input({
        pricing: { input: 0.005, output: 0.015, byModel: { [GLM_MODEL]: { input: 0.009, output: 0.03 } } },
      }),
    );
    const models = readYaml(modelsPath()).providers.joingonka.models as any[];
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId[GLM_MODEL].cost.output).toBe(0.03);
    expect(byId[DEEPSEEK_MODEL].cost.output).toBe(0.015);
  });

  it('falls back to the packaged price when the gateway gave none', async () => {
    await ompAdapter.apply(input({ pricing: null }));
    const models = readYaml(modelsPath()).providers.joingonka.models as any[];
    // Значение фолбэка живёт в constants.ts — сверяемся с ним, а не с числом.
    expect(models[0].cost).toEqual(piModelEntry(OPENCLAW_MODELS[0]!).cost);
  });

  it('keeps the root limited to `providers` (неизвестный корневой ключ ломает схему omp)', async () => {
    await ompAdapter.apply(input());
    expect(Object.keys(readYaml(modelsPath()))).toEqual(['providers']);
  });

  it('убирает посеянную устаревшую модель (Kimi K2.6) из НАШЕГО каталога', async () => {
    seed(
      'models.yml',
      [
        'providers:',
        '  joingonka:',
        '    baseUrl: https://gate.joingonka.ai/v1',
        '    api: openai-completions',
        '    apiKey: jg-old',
        '    models:',
        '      - id: moonshotai/Kimi-K2.6',
        '        name: Kimi K2.6 (Gonka)',
      ].join('\n') + '\n',
    );

    await ompAdapter.apply(input());

    const raw = readFileSync(modelsPath(), 'utf-8');
    expect(raw).not.toContain('Kimi');
    expect(raw).not.toContain('jg-old');
    expect(readYaml(modelsPath()).providers.joingonka.apiKey).toBe('jg-test123');
  });
});

describe('ompAdapter.apply — secret safety', () => {
  it('writes the literal key, never an env reference or a !command', async () => {
    await ompAdapter.apply(input());
    const raw = readFileSync(modelsPath(), 'utf-8');
    expect(raw).toContain('jg-test123');
    expect(raw).not.toContain('${');
    expect(raw).not.toMatch(/apiKey:\s*["']?!/);
  });

  it('does not instruct an env export', async () => {
    const result = await ompAdapter.apply(input());
    const joined = result.messages.join('\n');
    expect(joined).not.toMatch(/export\s+\w+=/);
    expect(joined).toContain('0o600');
  });

  it.runIf(platform() !== 'win32')('writes models.yml with 0o600 permissions', async () => {
    await ompAdapter.apply(input());
    expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
  });

  it.runIf(platform() !== 'win32')('tightens permissions of an existing world-readable file', async () => {
    seed('models.yml', 'providers: {}\n');
    await ompAdapter.apply(input());
    expect(statSync(modelsPath()).mode & 0o777).toBe(0o600);
  });
});

describe('ompAdapter.apply — сохранность чужого', () => {
  it('preserves foreign providers, foreign fields inside ours and COMMENTS', async () => {
    seed(
      'models.yml',
      [
        '# мои провайдеры',
        'providers:',
        '  spark: # домашний сервер',
        '    baseUrl: http://192.168.10.223:8000/v1',
        '    api: openai-completions',
        '    apiKey: dummy',
        '    models:',
        '      - id: minimax-m3',
        '  joingonka:',
        '    headers:',
        '      X-Team: platform',
        '    compat:',
        '      supportsStore: false',
      ].join('\n') + '\n',
    );

    await ompAdapter.apply(input());

    const raw = readFileSync(modelsPath(), 'utf-8');
    expect(raw).toContain('# мои провайдеры');
    expect(raw).toContain('# домашний сервер');

    const cfg = readYaml(modelsPath());
    expect(cfg.providers.spark.baseUrl).toBe('http://192.168.10.223:8000/v1');
    expect(cfg.providers.spark.apiKey).toBe('dummy');
    expect(cfg.providers.spark.models).toEqual([{ id: 'minimax-m3' }]);
    // чужие поля ВНУТРИ нашего блока — выбор пользователя, не наше дело
    expect(cfg.providers.joingonka.headers).toEqual({ 'X-Team': 'platform' });
    expect(cfg.providers.joingonka.compat).toEqual({ supportsStore: false });
    expect(cfg.providers.joingonka.apiKey).toBe('jg-test123');
  });

  it('keeps comment-only and empty files usable', async () => {
    seed('models.yml', '# пока пусто\n');
    await ompAdapter.apply(input());
    expect(readFileSync(modelsPath(), 'utf-8')).toContain('# пока пусто');
    expect(readYaml(modelsPath()).providers.joingonka.api).toBe('openai-completions');
  });

  it('does not re-fold long user strings', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    seed('models.yml', `providers:\n  spark:\n    baseUrl: http://x/v1\n    headers:\n      X-Note: ${long}\n`);
    await ompAdapter.apply(input());
    expect(readFileSync(modelsPath(), 'utf-8')).toContain(`X-Note: ${long}\n`);
  });

  it('replaces a scalar at providers.joingonka (наш ключ) with a proper block', async () => {
    seed('models.yml', 'providers:\n  joingonka: oops\n  spark:\n    baseUrl: http://x/v1\n');
    await ompAdapter.apply(input());
    const cfg = readYaml(modelsPath());
    expect(cfg.providers.joingonka.api).toBe('openai-completions');
    expect(cfg.providers.spark.baseUrl).toBe('http://x/v1');
  });

  it('seeds models.yml from a legacy models.json so its providers are not lost', async () => {
    // omp переносит models.json в models.yml, только пока yml НЕТ. Создай мы yml
    // с одним своим провайдером — перенос не случится, и чужие провайдеры из
    // models.json молча исчезнут из omp.
    seed(
      'models.json',
      `{
  // наследный конфиг
  "providers": { "spark": { "baseUrl": "http://x/v1", "api": "openai-completions", "apiKey": "dummy" } },
}`,
    );

    const result = await ompAdapter.apply(input());

    const cfg = readYaml(modelsPath());
    expect(cfg.providers.spark.baseUrl).toBe('http://x/v1');
    expect(cfg.providers.joingonka.apiKey).toBe('jg-test123');
    // исходник не трогаем и не выдаём за бэкап
    expect(existsSync(join(agentDir(), 'models.json'))).toBe(true);
    expect(result.messages.join('\n')).toContain('models.json');
  });

  it('refuses when the legacy models.json cannot be parsed', async () => {
    seed('models.json', '{ broken');
    await expect(ompAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(existsSync(modelsPath())).toBe(false);
  });
});

describe('ompAdapter.apply — отказ без записи', () => {
  it('refuses on broken models.yml: no write, no backup, no config.yml', async () => {
    const broken = 'providers:\n  spark: [unclosed\n  apiKey: sk-foreign-secret\n';
    seed('models.yml', broken);

    const error = await ompAdapter.apply(input()).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Nothing was written/);
    // Сообщение парсера содержит фрагмент файла — а там чужой секрет.
    expect((error as Error).message).not.toContain('sk-foreign-secret');
    expect(readFileSync(modelsPath(), 'utf-8')).toBe(broken);
    expect(backupsOf('models.yml')).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });

  it('refuses when the root of models.yml is not a mapping', async () => {
    seed('models.yml', '- just\n- a list\n');
    await expect(ompAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(modelsPath(), 'utf-8')).toBe('- just\n- a list\n');
    expect(backupsOf('models.yml')).toEqual([]);
  });

  it('refuses when `providers` is not a mapping', async () => {
    seed('models.yml', 'providers: nope\n');
    await expect(ompAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(modelsPath(), 'utf-8')).toBe('providers: nope\n');
  });

  it('refuses on broken config.yml BEFORE touching models.yml', async () => {
    seed('config.yml', 'modelRoles: [unclosed\n');
    await expect(ompAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(existsSync(modelsPath())).toBe(false);
    expect(readFileSync(configPath(), 'utf-8')).toBe('modelRoles: [unclosed\n');
    expect(backupsOf('config.yml')).toEqual([]);
  });

  it('refuses when modelRoles in config.yml is not a mapping', async () => {
    seed('config.yml', 'modelRoles: nope\n');
    await expect(ompAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(existsSync(modelsPath())).toBe(false);
  });
});

describe('ompAdapter.apply — модель по умолчанию (config.yml → modelRoles.default)', () => {
  it('sets modelRoles.default to <provider>/<model> on a fresh install', async () => {
    const result = await ompAdapter.apply(input());
    expect(readYaml(configPath()).modelRoles.default).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(result.messages.join('\n')).toContain(`joingonka/${DEEPSEEK_MODEL}`);
  });

  it('keeps a FOREIGN default untouched (byte-identical, no backup) without --model', async () => {
    const text = '# роли\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n  smol: openai/gpt-4.1-mini\n';
    seed('config.yml', text);

    const result = await ompAdapter.apply(input());

    expect(readFileSync(configPath(), 'utf-8')).toBe(text);
    expect(backupsOf('config.yml')).toEqual([]);
    expect(result.messages.join('\n')).toContain('anthropic/claude-sonnet-4-5');
  });

  it('writes an EXPLICIT model as the default even over a foreign one', async () => {
    seed(
      'config.yml',
      '# роли\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n  smol: openai/gpt-4.1-mini\ntheme:\n  dark: titanium\n',
    );

    await ompAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));

    const cfg = readYaml(configPath());
    expect(cfg.modelRoles.default).toBe(`joingonka/${GLM_MODEL}`);
    expect(cfg.modelRoles.smol).toBe('openai/gpt-4.1-mini'); // чужая роль цела
    expect(cfg.theme.dark).toBe('titanium'); // чужая настройка цела
    expect(readFileSync(configPath(), 'utf-8')).toContain('# роли');
    expect(backupsOf('config.yml').length).toBe(1);
  });

  it('keeps OUR current model (осознанный выбор пользователя) without --model', async () => {
    seed('config.yml', `modelRoles:\n  default: joingonka/${GLM_MODEL}\n`);
    await ompAdapter.apply(input());
    expect(readYaml(configPath()).modelRoles.default).toBe(`joingonka/${GLM_MODEL}`);
  });

  it('keeps our current model carrying a thinking suffix (:high)', async () => {
    const text = `modelRoles:\n  default: joingonka/${GLM_MODEL}:high\n`;
    seed('config.yml', text);
    await ompAdapter.apply(input());
    expect(readFileSync(configPath(), 'utf-8')).toBe(text);
  });

  it('replaces OUR stale model (Kimi K2.6 ушла из сети), with or without a suffix', async () => {
    seed('config.yml', 'modelRoles:\n  default: joingonka/moonshotai/Kimi-K2.6:high\n  slow: openai/o3\n');

    await ompAdapter.apply(input());

    const cfg = readYaml(configPath());
    expect(cfg.modelRoles.default).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(cfg.modelRoles.slow).toBe('openai/o3');
  });

  it('sets the default when modelRoles exists but has no default', async () => {
    seed('config.yml', 'modelRoles:\n  smol: openai/gpt-4.1-mini\n');
    await ompAdapter.apply(input());
    const cfg = readYaml(configPath());
    expect(cfg.modelRoles.default).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(cfg.modelRoles.smol).toBe('openai/gpt-4.1-mini');
  });

  it('updates an existing config.yaml in place instead of creating config.yml', async () => {
    seed('config.yaml', 'theme:\n  dark: titanium\n');
    await ompAdapter.apply(input());
    expect(existsSync(configPath())).toBe(false);
    const cfg = readYaml(join(agentDir(), 'config.yaml'));
    expect(cfg.modelRoles.default).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(cfg.theme.dark).toBe('titanium');
  });

  it('does NOT create config.yml next to a legacy settings.json (omp перенесёт его сам)', async () => {
    // omp переносит settings.json → config.yml только пока config.yml НЕТ. Создай
    // мы файл с одной строкой — перенос не случится, настройки пропадут.
    seed('settings.json', '{"theme":"dark"}');

    const result = await ompAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));

    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(modelsPath())).toBe(true); // провайдер при этом настроен
    const joined = result.messages.join('\n');
    expect(joined).toContain('settings.json');
    expect(joined).toContain(`joingonka/${GLM_MODEL}`);
  });
});

describe('ompAdapter.apply — наши убранные модели вне modelRoles.default', () => {
  // Класс инцидента (11.09.2026, уход Kimi K2.6): человек переустановил конфиг,
  // увидел «Verified», а роль `plan` продолжала ходить в убранную модель → 400.
  it('replaces OUR stale model in every role, keeping foreign and current ones', async () => {
    seed(
      'config.yml',
      [
        'modelRoles:',
        '  default: anthropic/claude-sonnet-4-5',
        '  plan: joingonka/moonshotai/Kimi-K2.6:high # планировщик',
        '  smol: joingonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        `  slow: joingonka/${GLM_MODEL}:high`,
        '  commit: openai/gpt-4.1-mini',
      ].join('\n') + '\n',
    );

    const result = await ompAdapter.apply(input());

    const roles = readYaml(configPath()).modelRoles;
    expect(roles.default).toBe('anthropic/claude-sonnet-4-5'); // чужой дефолт цел
    expect(roles.plan).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(roles.smol).toBe(`joingonka/${DEEPSEEK_MODEL}`);
    expect(roles.slow).toBe(`joingonka/${GLM_MODEL}:high`); // актуальная наша — как была
    expect(roles.commit).toBe('openai/gpt-4.1-mini');
    expect(readFileSync(configPath(), 'utf-8')).toContain('# планировщик');
    expect(result.messages.join('\n')).toContain('Cleaned up 2 references');
  });

  it('uses the explicit model as the replacement', async () => {
    seed('config.yml', 'modelRoles:\n  plan: joingonka/moonshotai/Kimi-K2.6\n');
    await ompAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));
    const roles = readYaml(configPath()).modelRoles;
    expect(roles.plan).toBe(`joingonka/${GLM_MODEL}`);
    expect(roles.default).toBe(`joingonka/${GLM_MODEL}`);
  });

  it('drops OUR stale entries from retry.fallbackChains, leaving the chains in place', async () => {
    seed(
      'config.yml',
      [
        'modelRoles:',
        '  default: anthropic/claude-sonnet-4-5',
        'retry:',
        '  modelFallback: true',
        '  fallbackChains:',
        '    default:',
        '      - joingonka/moonshotai/Kimi-K2.6',
        `      - joingonka/${GLM_MODEL}`,
        '      - openai/gpt-4.1-mini',
        '    judge:',
        '      - joingonka/moonshotai/Kimi-K2.6',
        '    tiny: [] # без запасных',
      ].join('\n') + '\n',
    );

    const result = await ompAdapter.apply(input());

    const retry = readYaml(configPath()).retry;
    expect(retry.modelFallback).toBe(true);
    expect(retry.fallbackChains.default).toEqual([`joingonka/${GLM_MODEL}`, 'openai/gpt-4.1-mini']);
    // Пустая цепочка у omp значит «без запасных» — ближе всего к прежнему смыслу;
    // удалённый ключ вернул бы роли встроенную цепочку.
    expect(retry.fallbackChains.judge).toEqual([]);
    expect(retry.fallbackChains.tiny).toEqual([]);
    expect(result.messages.join('\n')).toContain('Cleaned up 2 references');
  });

  it('counts a stale default too and stays silent when there is nothing to clean', async () => {
    seed('config.yml', 'modelRoles:\n  default: joingonka/moonshotai/Kimi-K2.6\n');
    const cleaned = await ompAdapter.apply(input());
    expect(cleaned.messages.join('\n')).toContain('Cleaned up 1 reference');

    const again = await ompAdapter.apply(input());
    expect(again.messages.join('\n')).not.toContain('Cleaned up');
  });
});

describe('ompAdapter.apply — backups & idempotency', () => {
  it('backs up an existing models.yml and reports no backup for a new one', async () => {
    const fresh = await ompAdapter.apply(input());
    expect(fresh.backupPath).toBeNull();

    const again = await ompAdapter.apply(input());
    expect(again.backupPath).not.toBeNull();
    expect(backupsOf('models.yml').length).toBe(1);
  });

  it('is byte-identical on a second apply (both files)', async () => {
    seed('models.yml', '# мои провайдеры\nproviders:\n  spark:\n    baseUrl: http://x/v1\n');
    await ompAdapter.apply(input());
    const models1 = readFileSync(modelsPath(), 'utf-8');
    const config1 = readFileSync(configPath(), 'utf-8');

    await ompAdapter.apply(input());

    expect(readFileSync(modelsPath(), 'utf-8')).toBe(models1);
    expect(readFileSync(configPath(), 'utf-8')).toBe(config1);
  });

  it('writes into PI_CODING_AGENT_DIR when it is set', async () => {
    const custom = join(tmpDir, 'portable-agent');
    process.env.PI_CODING_AGENT_DIR = custom;

    const result = await ompAdapter.apply(input());

    expect(result.configPath).toBe(join(custom, 'models.yml'));
    expect(existsSync(join(custom, 'config.yml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.omp'))).toBe(false);
  });
});

describe('ompAgentDir — чужая платформа через PathContext (0.5.0)', () => {
  // Сверено 21.09.2026 по packages/utils/src/dirs.ts (main fb941af0): корень —
  // path.join(os.homedir(), PI_CONFIG_DIR || '.omp') на ВСЕХ платформах, особого
  // случая для Windows нет; PI_CODING_AGENT_DIR проходит через path.resolve, а
  // именованный профиль его игнорирует.
  const win = (env: NodeJS.ProcessEnv) => ({ platform: 'win32' as const, env, home: 'C:\\Users\\u' });
  const linux = (env: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, env, home: '/home/u' });

  it('uses <home>\\.omp\\agent on Windows — no AppData special case', () => {
    expect(ompAgentDir(win({}))).toBe('C:\\Users\\u\\.omp\\agent');
    expect(ompAgentDir(win({ APPDATA: 'C:\\AD', LOCALAPPDATA: 'C:\\LAD' }))).toBe(
      'C:\\Users\\u\\.omp\\agent',
    );
  });

  it('honours PI_CONFIG_DIR, profiles and PI_CODING_AGENT_DIR with Windows separators', () => {
    expect(ompAgentDir(win({ PI_CONFIG_DIR: '.omp-alt' }))).toBe('C:\\Users\\u\\.omp-alt\\agent');
    expect(ompAgentDir(win({ OMP_PROFILE: 'work' }))).toBe('C:\\Users\\u\\.omp\\profiles\\work\\agent');
    expect(ompAgentDir(win({ PI_CODING_AGENT_DIR: 'D:\\omp\\agent' }))).toBe('D:\\omp\\agent');
    // Именованный профиль переопределение каталога агента игнорирует.
    expect(ompAgentDir(win({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: 'D:\\omp\\agent' }))).toBe(
      'C:\\Users\\u\\.omp\\profiles\\work\\agent',
    );
  });

  it('keeps the POSIX layout unchanged', () => {
    expect(ompAgentDir(linux({}))).toBe('/home/u/.omp/agent');
    expect(ompAgentDir(linux({ PI_PROFILE: 'legacy' }))).toBe('/home/u/.omp/profiles/legacy/agent');
    expect(ompAgentDir(linux({ OMP_PROFILE: '', PI_PROFILE: 'legacy' }))).toBe('/home/u/.omp/agent');
    expect(ompAgentDir(linux({ PI_CODING_AGENT_DIR: '/srv/omp' }))).toBe('/srv/omp');
  });

  it('rejects a Windows-reserved profile name the same way omp does', () => {
    expect(() => ompAgentDir(win({ OMP_PROFILE: 'con' }))).toThrow(/Invalid omp profile/);
  });
});
