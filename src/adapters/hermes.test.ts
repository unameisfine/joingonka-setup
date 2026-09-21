/**
 * Тесты адаптера Hermes (YAML, ~/.hermes/config.yaml).
 *
 * Hermes Agent (Nous Research) читает ключ кастомного endpoint ТОЛЬКО из
 * model.api_key (hermes_cli/config.py:1079); OPENAI_API_KEY в ~/.hermes/.env
 * для custom-endpoint НЕ работает (реальный HTTP 401, проверено 20.08.2026 на
 * v0.20.4). Проверяем:
 * - model.provider=custom, model.model=<выбранная>, base_url С /v1;
 * - ключ ЛИТЕРАЛОМ в model.api_key (не ${ENV}), НИКАКИХ ~/.hermes/.env /
 *   OPENAI_API_KEY; файл 0o600;
 * - fallback_providers НЕ создаётся (в Hermes фолбэки opt-in), существующий
 *   пользовательский — не трогается;
 * - YAML deep-merge: чужие ключи (mcp_servers, agent, compression,
 *   custom_providers), чужие поля внутри model и КОММЕНТАРИИ сохраняются;
 * - reconcile: устаревшая модель в model.model перезаписывается;
 * - guard'ы: model-скаляр заменяется map'ом; корень-не-map и битый YAML →
 *   ОТКАЗ без записи и без бэкапа (конфиг пользователя не теряется);
 * - наши убранные модели в fallback_providers / fallback_model вычищаются;
 * - путь: HERMES_HOME, на Windows — %LOCALAPPDATA%\hermes;
 * - бэкап при наличии файла, идемпотентность, chmod 600.
 *
 * HOME и HERMES_HOME перенаправляются в tmp; восстановление в afterEach.
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
import { hermesAdapter, hermesConfigPath } from './hermes.js';
import { DEFAULT_MODEL, DEEPSEEK_MODEL } from '../constants.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalHermesHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-hermes-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  // HERMES_HOME мог быть установлен в окружении — изолируем тесты
  originalHermesHome = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalHermesHome === undefined) {
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = originalHermesHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

const input = (scope: 'user' | 'local' = 'user') => ({
  apiKey: 'jg-test123',
  model: DEFAULT_MODEL,
  scope,
});

/** Путь к дефолтному конфигу внутри tmp-HOME. */
const defaultConfigPath = () => join(tmpDir, '.hermes', 'config.yaml');

/** Прочитать и распарсить записанный YAML-конфиг. */
const readConfig = (path = defaultConfigPath()) =>
  parse(readFileSync(path, 'utf-8')) as Record<string, any>;

/** Создать ~/.hermes с готовым config.yaml. */
const seedConfig = (yamlText: string) => {
  const dir = join(tmpDir, '.hermes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), yamlText);
};

describe('hermesAdapter — shape', () => {
  it('has id=hermes and format=yaml (первый YAML-пишущий адаптер)', () => {
    expect(hermesAdapter.id).toBe('hermes');
    expect(hermesAdapter.format).toBe('yaml');
    expect(hermesAdapter.label).toContain('Hermes');
  });
});

describe('hermesAdapter.resolvePath', () => {
  it('returns ~/.hermes/config.yaml for user scope by default', () => {
    expect(hermesAdapter.resolvePath('user')).toBe(defaultConfigPath());
  });

  it('honours HERMES_HOME (каталог, не путь к файлу) when set', () => {
    const customHome = join(tmpDir, 'custom-hermes-home');
    process.env.HERMES_HOME = customHome;
    expect(hermesAdapter.resolvePath('user')).toBe(join(customHome, 'config.yaml'));
  });
});

describe('hermesAdapter.apply — model block', () => {
  it('writes provider=custom, model, base_url WITH /v1 and the api_key', async () => {
    const result = await hermesAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(defaultConfigPath());

    const cfg = readConfig();
    expect(cfg.model.provider).toBe('custom');
    expect(cfg.model.model).toBe(DEFAULT_MODEL);
    // Hermes OpenAI-совместим и сам дописывает /chat/completions → база С /v1
    expect(cfg.model.base_url).toBe('https://gate.joingonka.ai/v1');
    expect(cfg.model.base_url).toContain('/v1');
    expect(cfg.model.api_key).toBe('jg-test123');
  });

  it('passes the selected model through (--model deepseek)', async () => {
    await hermesAdapter.apply({ ...input(), model: DEEPSEEK_MODEL });
    expect(readConfig().model.model).toBe(DEEPSEEK_MODEL);
  });

  it('reconcile: перезаписывает устаревшую модель/URL/ключ на повторной установке', async () => {
    seedConfig(
      [
        'model:',
        '  provider: custom',
        '  model: Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        '  base_url: https://old.example.com/v1',
        '  api_key: jg-oldkey',
      ].join('\n') + '\n',
    );

    await hermesAdapter.apply(input());

    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    const cfg = readConfig();
    expect(cfg.model.model).toBe(DEFAULT_MODEL);
    expect(cfg.model.base_url).toBe('https://gate.joingonka.ai/v1');
    expect(cfg.model.api_key).toBe('jg-test123');
    expect(raw).not.toContain('Qwen');
    expect(raw).not.toContain('jg-oldkey');
  });
});

describe('hermesAdapter.apply — secret safety (ГЛАВНАЯ ГРАБЛЯ: только model.api_key)', () => {
  it('writes the literal jg- key (not a ${ENV} reference)', async () => {
    await hermesAdapter.apply(input());
    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).toContain('jg-test123');
    expect(raw).not.toContain('${');
  });

  it('puts the key ONLY in model.api_key — never in .env / OPENAI_API_KEY', async () => {
    await hermesAdapter.apply(input());
    // Ключ в .env НЕ работает (док Hermes врёт: custom endpoint читает только
    // model.api_key → с .env гейт отдаёт 401). Файл .env не создаём вообще.
    expect(existsSync(join(tmpDir, '.hermes', '.env'))).toBe(false);
    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).not.toContain('OPENAI_API_KEY');
  });

  it('does NOT instruct an env export; warns that .env does not work', async () => {
    const result = await hermesAdapter.apply(input());
    const joined = result.messages.join('\n');
    expect(joined).not.toMatch(/export\s+\w*API_KEY=/);
    expect(joined).toContain('model.api_key');
    expect(joined).toContain('0o600');
  });
});

describe('hermesAdapter.apply — fallbacks are opt-in', () => {
  it('does NOT create a fallback_providers block', async () => {
    await hermesAdapter.apply(input());
    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).not.toContain('fallback_providers');
    expect(readConfig().fallback_providers).toBeUndefined();
  });

  it('preserves a user-defined fallback_providers block untouched', async () => {
    seedConfig(
      ['fallback_providers:', '  - provider: openai', '    model: gpt-5.4'].join('\n') + '\n',
    );

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.fallback_providers).toEqual([{ provider: 'openai', model: 'gpt-5.4' }]);
  });
});

describe('hermesAdapter.apply — YAML deep merge (do not clobber foreign data)', () => {
  it('preserves foreign top-level keys: mcp_servers, agent, compression, custom_providers', async () => {
    seedConfig(
      [
        'mcp_servers:',
        '  github:',
        '    command: npx',
        '    args: [-y, "@modelcontextprotocol/server-github"]',
        'agent:',
        '  max_iterations: 25',
        'compression:',
        '  enabled: true',
        'custom_providers:',
        '  my_vllm:',
        '    base_url: http://localhost:8000/v1',
      ].join('\n') + '\n',
    );

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.mcp_servers.github.command).toBe('npx');
    expect(cfg.agent.max_iterations).toBe(25);
    expect(cfg.compression.enabled).toBe(true);
    expect(cfg.custom_providers.my_vllm.base_url).toBe('http://localhost:8000/v1');
    expect(cfg.model.provider).toBe('custom');
  });

  it('preserves foreign fields INSIDE the model block', async () => {
    seedConfig(['model:', '  temperature: 0.5', '  provider: custom'].join('\n') + '\n');

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.model.temperature).toBe(0.5);
    expect(cfg.model.api_key).toBe('jg-test123');
  });

  it('preserves YAML comments of the existing config', async () => {
    seedConfig(
      [
        '# my precious comment',
        'mcp_servers:',
        '  github: # inline note',
        '    command: npx',
      ].join('\n') + '\n',
    );

    await hermesAdapter.apply(input());

    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).toContain('# my precious comment');
    expect(raw).toContain('# inline note');
  });
});

describe('hermesAdapter.apply — guards for malformed shapes', () => {
  it('replaces a scalar `model:` value with our map (no crash)', async () => {
    seedConfig('model: just-a-string\nagent:\n  max_iterations: 10\n');

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.model.provider).toBe('custom');
    expect(cfg.model.api_key).toBe('jg-test123');
    expect(cfg.agent.max_iterations).toBe(10); // соседний ключ цел
  });

  // ★ До 0.4.5 оба случая ниже означали «стартуем с пустого документа»: файл
  // перезаписывался, и человек терял mcp_servers, память, расписания — всё, что
  // жило в config.yaml. Оставался .bak, о котором ещё надо догадаться. Теперь —
  // отказ, как у JSON-адаптеров: ни записи, ни бэкапа.
  const backups = () =>
    readdirSync(join(tmpDir, '.hermes')).filter((f) => f.startsWith('config.yaml.bak.'));

  it('refuses a config whose root is not a map (no write, no backup)', async () => {
    seedConfig('- just\n- a list\n');

    await expect(hermesAdapter.apply(input())).rejects.toThrow(/Nothing was written/);

    expect(readFileSync(defaultConfigPath(), 'utf-8')).toBe('- just\n- a list\n');
    expect(backups()).toHaveLength(0);
  });

  it('refuses malformed YAML and names the file and the line', async () => {
    const broken = 'agent:\n  max_iterations: 10\nmodel: [unclosed\n  broken: yes\n';
    seedConfig(broken);

    await expect(hermesAdapter.apply(input())).rejects.toThrow(
      /config\.yaml is not valid YAML.*line \d+.*Nothing was written/s,
    );

    expect(readFileSync(defaultConfigPath(), 'utf-8')).toBe(broken);
    expect(backups()).toHaveLength(0);
  });

  it('treats an empty or comment-only file as a fresh config', async () => {
    seedConfig('# мои заметки\n');

    await hermesAdapter.apply(input());

    expect(readConfig().model.provider).toBe('custom');
    expect(readFileSync(defaultConfigPath(), 'utf-8')).toContain('# мои заметки');
  });
});

describe('hermesAdapter.apply — idempotency', () => {
  it('is byte-identical on a second apply', async () => {
    await hermesAdapter.apply(input());
    const first = readFileSync(defaultConfigPath(), 'utf-8');
    await hermesAdapter.apply(input());
    const second = readFileSync(defaultConfigPath(), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('hermesAdapter.apply — backups & HERMES_HOME', () => {
  it('creates a backup when the file already exists', async () => {
    seedConfig('agent:\n  max_iterations: 10\n');

    const result = await hermesAdapter.apply(input());

    expect(result.backupPath).not.toBeNull();
    const backups = readdirSync(join(tmpDir, '.hermes')).filter((f) =>
      f.startsWith('config.yaml.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it('does not create a backup when the file does not exist', async () => {
    const result = await hermesAdapter.apply(input());
    expect(result.backupPath).toBeNull();
  });

  it('respects HERMES_HOME for the write target', async () => {
    const customHome = join(tmpDir, 'portable-hermes');
    process.env.HERMES_HOME = customHome;

    const result = await hermesAdapter.apply(input());

    expect(result.configPath).toBe(join(customHome, 'config.yaml'));
    expect(existsSync(join(customHome, 'config.yaml'))).toBe(true);
    expect(existsSync(defaultConfigPath())).toBe(false);
    expect(readConfig(join(customHome, 'config.yaml')).model.provider).toBe('custom');
  });
});

describe('hermesAdapter.apply — file permissions', () => {
  // chmod-биты не воспроизводятся на Windows; проверяем только на posix
  it.runIf(platform() !== 'win32')('writes the file with 0o600 permissions', async () => {
    await hermesAdapter.apply(input());
    const mode = statSync(defaultConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('hermesAdapter.apply — каноничный ключ модели (0.4.5)', () => {
  it('overrides model.default set by the Hermes wizard', async () => {
    // Раньше писали только model.model, а Hermes читает model.default и
    // псевдонимом её не перебивает — пользователь оставался на старой модели.
    seedConfig('model:\n  provider: custom\n  default: moonshotai/Kimi-K2.6\n  temperature: 0.4\n');

    await hermesAdapter.apply({ ...input(), model: DEEPSEEK_MODEL });

    const cfg = readConfig();
    expect(cfg.model.default).toBe(DEEPSEEK_MODEL);
    expect(cfg.model.temperature).toBe(0.4); // чужое поле цело
  });

  it('drops the stale name alias and env-based key fields', async () => {
    seedConfig('model:\n  name: old-model\n  key_env: OPENAI_API_KEY\n  api_mode: openai\n');

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.model.name).toBeUndefined();
    expect(cfg.model.key_env).toBeUndefined();
    expect(cfg.model.api_mode).toBeUndefined();
    expect(cfg.model.api_key).toBe('jg-test123');
  });
});

describe('hermesConfigPath — где Hermes держит config.yaml (0.4.5)', () => {
  // Исходник hermes_constants.py::_get_platform_default_hermes_home и дока
  // website/docs/user-guide/windows-native.md, сверено 21.09.2026: на Windows —
  // %LOCALAPPDATA%\hermes, иначе ~/.hermes; HERMES_HOME перекрывает оба, тильда
  // в нём раскрывается (os.path.expanduser).
  it('Windows: %LOCALAPPDATA%\\hermes\\config.yaml', () => {
    const path = hermesConfigPath({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      home: 'C:\\Users\\u',
    });
    expect(path).toBe('C:\\Users\\u\\AppData\\Local\\hermes\\config.yaml');
  });

  it('Windows without LOCALAPPDATA falls back to AppData\\Local under home', () => {
    const path = hermesConfigPath({ platform: 'win32', env: {}, home: 'C:\\Users\\u' });
    expect(path).toBe('C:\\Users\\u\\AppData\\Local\\hermes\\config.yaml');
  });

  it('HERMES_HOME wins on every platform and expands a leading tilde', () => {
    expect(
      hermesConfigPath({
        platform: 'win32',
        env: { HERMES_HOME: 'D:\\hermes', LOCALAPPDATA: 'C:\\L' },
        home: 'C:\\Users\\u',
      }),
    ).toBe('D:\\hermes\\config.yaml');
    expect(
      hermesConfigPath({ platform: 'linux', env: { HERMES_HOME: '~/h' }, home: '/home/u' }),
    ).toBe('/home/u/h/config.yaml');
  });

  it('Linux and macOS: ~/.hermes/config.yaml', () => {
    expect(hermesConfigPath({ platform: 'linux', env: {}, home: '/home/u' })).toBe(
      '/home/u/.hermes/config.yaml',
    );
    expect(hermesConfigPath({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe(
      '/Users/u/.hermes/config.yaml',
    );
  });
});

describe('hermesAdapter.apply — ушедшие модели в запасных (0.4.5)', () => {
  // Формат сверен 21.09.2026 по hermes_cli/fallback_config.py и доке
  // website/docs/user-guide/features/fallback-providers.md: `fallback_providers` —
  // список записей { provider, model, base_url?, api_key?/key_env? } (или одна
  // запись-словарь); `fallback_model` — прежний ключ той же формы.
  it('drops fallback entries that point at our gateway with a retired model', async () => {
    seedConfig(
      [
        '# запасные',
        'fallback_providers:',
        '  - provider: custom',
        '    model: moonshotai/Kimi-K2.6',
        '    base_url: https://gate.joingonka.ai/v1/',
        '    api_key: jg-old',
        '  - provider: openrouter',
        '    model: moonshotai/Kimi-K2.6 # чужой провайдер — не наше дело',
        '  - provider: custom',
        '    model: zai-org/GLM-5.3-Flash',
        '    base_url: https://gate.joingonka.ai/v1',
      ].join('\n') + '\n',
    );

    const result = await hermesAdapter.apply(input());

    expect(readConfig().fallback_providers).toEqual([
      { provider: 'openrouter', model: 'moonshotai/Kimi-K2.6' },
      {
        provider: 'custom',
        model: 'zai-org/GLM-5.3-Flash',
        base_url: 'https://gate.joingonka.ai/v1',
      },
    ]);
    const raw = readFileSync(defaultConfigPath(), 'utf-8');
    expect(raw).toContain('# запасные');
    expect(raw).toContain('# чужой провайдер — не наше дело');
    expect(result.messages.join('\n')).toMatch(/1 reference.*no longer served/i);
  });

  it('removes the key when nothing is left, including the legacy single-entry form', async () => {
    seedConfig(
      [
        'fallback_providers:',
        '  - provider: custom',
        '    model: moonshotai/Kimi-K2.6',
        '    base_url: https://gate.joingonka.ai/v1',
        'fallback_model:',
        '  provider: custom',
        '  model: Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
        '  base_url: https://gate.joingonka.ai/v1',
        'agent:',
        '  max_iterations: 10',
      ].join('\n') + '\n',
    );

    await hermesAdapter.apply(input());

    const cfg = readConfig();
    expect(cfg.fallback_providers).toBeUndefined();
    expect(cfg.fallback_model).toBeUndefined();
    expect(cfg.agent.max_iterations).toBe(10);
  });

  it('keeps a custom endpoint that is not ours, whatever its model is called', async () => {
    const yaml =
      [
        'fallback_providers:',
        '  - provider: custom',
        '    model: moonshotai/Kimi-K2.6',
        '    base_url: http://localhost:8000/v1',
      ].join('\n') + '\n';
    seedConfig(yaml);

    const result = await hermesAdapter.apply(input());

    expect(readConfig().fallback_providers).toEqual([
      { provider: 'custom', model: 'moonshotai/Kimi-K2.6', base_url: 'http://localhost:8000/v1' },
    ]);
    expect(result.messages.join('\n')).not.toMatch(/no longer served/i);
  });
});
