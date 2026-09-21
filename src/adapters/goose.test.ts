/**
 * Тесты адаптера Goose (https://github.com/aaif-goose/goose, ранее block/goose).
 *
 * Формат сверен с первоисточником 21.09.2026 (goose 1.51.0: документация
 * getting-started/providers «Configure Custom Provider», guides/config-files;
 * исходники crates/goose-providers/src/declarative.rs, crates/goose/src/config/
 * {declarative_providers,providers,migrations,base,paths}.rs):
 *   - ~/.config/goose/custom_providers/<id>.json — описание провайдера (СТРОГИЙ JSON);
 *   - ключ: Goose берёт его из env, системного keyring либо secrets.yaml (когда
 *     хранилище файловое); поля для литерала в JSON провайдера НЕТ;
 *   - ~/.config/goose/config.yaml — active_provider + providers.<id>.model, в
 *     старых конфигах — плоские GOOSE_PROVIDER / GOOSE_MODEL.
 *
 * Проверяем:
 * - файл провайдера: полный URL …/v1/chat/completions, engine=openai, имя секрета,
 *   модели с context_limit; чужие поля целы; нестрогий JSON → отказ;
 * - ключ: пишем в secrets.yaml ТОЛЬКО когда хранилище файловое (keyring выключен
 *   либо secrets.yaml уже есть); иначе ключ никуда не пишем и честно говорим, что
 *   остался один шаг; env за пользователя не персистим;
 * - модель по умолчанию: правило п.5 в ОБОИХ раскладках config.yaml;
 * - чужие секреты, чужие провайдеры, КОММЕНТАРИИ; отказ на битом файле без записи;
 * - пути: GOOSE_PATH_ROOT, XDG_CONFIG_HOME; идемпотентность.
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
import { join, dirname } from 'node:path';
import { parse } from 'yaml';
import { gooseAdapter, gooseConfigDir } from './goose.js';
import type { ApplyInput } from './types.js';
import {
  CODING_AGENT_DEFAULT_MODEL,
  DEEPSEEK_MODEL,
  DEFAULT_MODEL,
  GLM_MODEL,
} from '../constants.js';

const ENV_KEYS = [
  'HOME',
  'GOOSE_PATH_ROOT',
  'XDG_CONFIG_HOME',
  'GOOSE_DISABLE_KEYRING',
  'APPDATA',
  'GOOSE_PROVIDER',
  'GOOSE_MODEL',
];

/** Пути ниже — раскладка Linux/macOS; на Windows у Goose другой корень (%APPDATA%). */
const posix = platform() !== 'win32';

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-goose-test-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  // На Windows корень конфигов — %APPDATA%; уводим его в tmp, чтобы не задеть живой.
  if (!posix) process.env.APPDATA = join(tmpDir, 'AppData', 'Roaming');
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

const configDir = () =>
  posix ? join(tmpDir, '.config', 'goose') : join(tmpDir, 'AppData', 'Roaming', 'Block', 'goose', 'config');
const providerPath = () => join(configDir(), 'custom_providers', 'custom_joingonka.json');
const configPath = () => join(configDir(), 'config.yaml');
const secretsPath = () => join(configDir(), 'secrets.yaml');

const readProvider = () => JSON.parse(readFileSync(providerPath(), 'utf-8')) as Record<string, any>;
const readYaml = (path: string) => parse(readFileSync(path, 'utf-8')) as Record<string, any>;

const seed = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const backupsIn = (dir: string, name: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.bak.`)) : [];

/** Всё, что адаптер мог записать: для проверок «ключ никуда не попал». */
const allWrittenText = () =>
  [providerPath(), configPath(), secretsPath()]
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf-8'))
    .join('\n');

describe('gooseAdapter — shape', () => {
  it('is a JSON-writing OpenAI-mode adapter with the coding-agent default model', () => {
    expect(gooseAdapter.id).toBe('goose');
    expect(gooseAdapter.format).toBe('json');
    expect(gooseAdapter.apiMode).toBe('openai');
    expect(gooseAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(gooseAdapter.supportsLocalScope).toBeFalsy();
    expect(gooseAdapter.label).toMatch(/Goose/);
  });
});

describe('gooseAdapter.resolvePath', () => {
  it.runIf(posix)('defaults to ~/.config/goose/custom_providers/custom_joingonka.json', () => {
    expect(gooseAdapter.resolvePath('user')).toBe(providerPath());
  });

  it.runIf(posix)('honours an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
    process.env.XDG_CONFIG_HOME = join(tmpDir, 'xdg');
    expect(gooseAdapter.resolvePath('user')).toBe(
      join(tmpDir, 'xdg', 'goose', 'custom_providers', 'custom_joingonka.json'),
    );
    process.env.XDG_CONFIG_HOME = 'relative/xdg';
    expect(gooseAdapter.resolvePath('user')).toBe(providerPath());
  });

  it('honours an absolute GOOSE_PATH_ROOT (<root>/config) and ignores a relative one', () => {
    process.env.GOOSE_PATH_ROOT = join(tmpDir, 'goose-root');
    expect(gooseAdapter.resolvePath('user')).toBe(
      join(tmpDir, 'goose-root', 'config', 'custom_providers', 'custom_joingonka.json'),
    );
    process.env.GOOSE_PATH_ROOT = 'relative/root';
    expect(gooseAdapter.resolvePath('user')).toBe(providerPath());
  });
});

describe('gooseConfigDir — чужая платформа через PathContext', () => {
  // Каталог считает crate etcetera (choose_app_strategy): Windows — known folder
  // RoamingAppData + автор + приложение + config; Linux И macOS — XDG.
  const win = (env: NodeJS.ProcessEnv) => ({ platform: 'win32' as const, env, home: 'C:\\Users\\u' });

  it('Windows: %APPDATA%\\Block\\goose\\config (как в документации Goose)', () => {
    expect(gooseConfigDir(win({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }))).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Block\\goose\\config',
    );
  });

  it('Windows without APPDATA falls back to the profile folder', () => {
    expect(gooseConfigDir(win({}))).toBe('C:\\Users\\u\\AppData\\Roaming\\Block\\goose\\config');
  });

  it('Windows ignores XDG_CONFIG_HOME but honours an absolute GOOSE_PATH_ROOT', () => {
    expect(gooseConfigDir(win({ XDG_CONFIG_HOME: 'D:\\xdg', APPDATA: 'C:\\AD' }))).toBe(
      'C:\\AD\\Block\\goose\\config',
    );
    expect(gooseConfigDir(win({ GOOSE_PATH_ROOT: 'D:\\goose-root', APPDATA: 'C:\\AD' }))).toBe(
      'D:\\goose-root\\config',
    );
  });

  it('macOS uses the XDG layout too (~/.config/goose, не ~/Library)', () => {
    expect(gooseConfigDir({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe('/Users/u/.config/goose');
  });

  it('Linux: an absolute XDG_CONFIG_HOME wins, a relative one is ignored', () => {
    const linux = (env: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, env, home: '/home/u' });
    expect(gooseConfigDir(linux({ XDG_CONFIG_HOME: '/data/xdg' }))).toBe('/data/xdg/goose');
    expect(gooseConfigDir(linux({ XDG_CONFIG_HOME: 'xdg' }))).toBe('/home/u/.config/goose');
  });
});

describe('gooseAdapter.apply — файл провайдера (custom_providers/custom_joingonka.json)', () => {
  it('writes a declarative provider exactly in the documented shape', async () => {
    const result = await gooseAdapter.apply(input());
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(providerPath());

    const provider = readProvider();
    expect(provider.name).toBe('custom_joingonka'); // совпадает с именем файла
    expect(provider.engine).toBe('openai');
    expect(provider.display_name).toBe('JoinGonka');
    // Полный URL, как в примере документации: старые сборки Goose путь не достраивают.
    expect(provider.base_url).toBe('https://gate.joingonka.ai/v1/chat/completions');
    expect(provider.api_key_env).toBe('CUSTOM_JOINGONKA_API_KEY');
    expect(provider.requires_auth).toBe(true);
    expect(provider.supports_streaming).toBe(true);
  });

  it('lists the whole catalog with REAL context limits and nothing invented', async () => {
    await gooseAdapter.apply(input());
    const models = readProvider().models as any[];
    const byName = Object.fromEntries(models.map((m) => [m.name, m]));

    expect(Object.keys(byName).sort()).toEqual([DEEPSEEK_MODEL, DEFAULT_MODEL, GLM_MODEL].sort());
    expect(byName[DEFAULT_MODEL].context_limit).toBe(200000);
    expect(byName[DEEPSEEK_MODEL].context_limit).toBe(380000);
    expect(byName[GLM_MODEL].context_limit).toBe(390000);
    // У ModelInfo Goose нет поля потолка выдачи — не выдумываем его.
    for (const model of models) expect(Object.keys(model).sort()).toEqual(['context_limit', 'name']);
  });

  it('never puts the key into the provider file (у Goose там только ИМЯ секрета)', async () => {
    await gooseAdapter.apply(input());
    expect(readFileSync(providerPath(), 'utf-8')).not.toContain('jg-test123');
  });

  it('убирает посеянную устаревшую модель (Kimi K2.6) и сохраняет чужие поля', async () => {
    seed(
      providerPath(),
      JSON.stringify(
        {
          name: 'custom_joingonka',
          engine: 'openai',
          display_name: 'JoinGonka',
          api_key_env: 'CUSTOM_JOINGONKA_API_KEY',
          base_url: 'https://old.example.com/v1/chat/completions',
          models: [{ name: 'moonshotai/Kimi-K2.6', context_limit: 262144 }],
          headers: { 'X-Team': 'platform' },
          timeout_seconds: 900,
        },
        null,
        2,
      ),
    );

    await gooseAdapter.apply(input());

    const provider = readProvider();
    expect(JSON.stringify(provider)).not.toContain('Kimi');
    expect(provider.base_url).toBe('https://gate.joingonka.ai/v1/chat/completions');
    expect(provider.headers).toEqual({ 'X-Team': 'platform' });
    expect(provider.timeout_seconds).toBe(900);
  });

  it('keeps command-based auth: api_key_env and auth are mutually exclusive in Goose', async () => {
    // Оба поля сразу → Goose отвергает провайдера (validate_auth). Команду завёл
    // пользователь — не ломаем её и ключ никуда не пишем.
    process.env.GOOSE_DISABLE_KEYRING = '1';
    seed(
      providerPath(),
      JSON.stringify({
        name: 'custom_joingonka',
        engine: 'openai',
        display_name: 'JoinGonka',
        base_url: 'https://gate.joingonka.ai/v1/chat/completions',
        models: [],
        auth: { command: '/usr/local/bin/get-gonka-key' },
      }),
    );

    const result = await gooseAdapter.apply(input());

    const provider = readProvider();
    expect(provider.auth).toEqual({ command: '/usr/local/bin/get-gonka-key' });
    expect(provider.api_key_env ?? '').toBe('');
    expect(existsSync(secretsPath())).toBe(false);
    expect(result.messages.join('\n')).toMatch(/auth/);
  });

  it.runIf(posix)('writes the provider file with 0o600 permissions', async () => {
    await gooseAdapter.apply(input());
    expect(statSync(providerPath()).mode & 0o777).toBe(0o600);
  });
});

describe('gooseAdapter.apply — ключ: keyring по умолчанию', () => {
  it('writes the key NOWHERE and says which single step is left', async () => {
    const result = await gooseAdapter.apply(input());

    expect(existsSync(secretsPath())).toBe(false);
    expect(allWrittenText()).not.toContain('jg-test123');

    const joined = result.messages.join('\n');
    expect(joined).toContain('goose configure');
    expect(joined).toContain('CUSTOM_JOINGONKA_API_KEY');
    expect(joined).toMatch(/keyring|keychain/i);
    // env за пользователя не персистим и не предлагаем класть его в профиль
    expect(joined).not.toMatch(/export\s+\w+=/);
    expect(joined).not.toContain('jg-test123');
  });

  it('never flips GOOSE_DISABLE_KEYRING (это спрятало бы чужие секреты из keyring)', async () => {
    seed(configPath(), 'GOOSE_MODE: auto\n');
    await gooseAdapter.apply(input());
    expect(readFileSync(configPath(), 'utf-8')).not.toContain('GOOSE_DISABLE_KEYRING');
  });
});

describe('gooseAdapter.apply — ключ: файловое хранилище (secrets.yaml)', () => {
  it('writes the literal key when GOOSE_DISABLE_KEYRING is set in the environment', async () => {
    process.env.GOOSE_DISABLE_KEYRING = '1';

    const result = await gooseAdapter.apply(input());

    expect(readYaml(secretsPath()).CUSTOM_JOINGONKA_API_KEY).toBe('jg-test123');
    const joined = result.messages.join('\n');
    expect(joined).toContain(secretsPath());
    expect(joined).toContain('0o600');
    expect(joined).not.toMatch(/export\s+\w+=/);
  });

  it('treats any value of the env flag as "disabled" — как сам Goose', async () => {
    process.env.GOOSE_DISABLE_KEYRING = '';
    await gooseAdapter.apply(input());
    expect(readYaml(secretsPath()).CUSTOM_JOINGONKA_API_KEY).toBe('jg-test123');
  });

  it.each([['true'], ['"true"'], ['"1"']])(
    'writes the key when config.yaml has GOOSE_DISABLE_KEYRING: %s',
    async (value) => {
      seed(configPath(), `GOOSE_DISABLE_KEYRING: ${value}\n`);
      await gooseAdapter.apply(input());
      expect(readYaml(secretsPath()).CUSTOM_JOINGONKA_API_KEY).toBe('jg-test123');
    },
  );

  it('does NOT treat GOOSE_DISABLE_KEYRING: false as disabled', async () => {
    seed(configPath(), 'GOOSE_DISABLE_KEYRING: false\n');
    await gooseAdapter.apply(input());
    expect(existsSync(secretsPath())).toBe(false);
  });

  it('adds the key to an EXISTING secrets.yaml, keeping foreign secrets and comments', async () => {
    // Файл есть → Goose на этой машине уже хранит секреты в файле (нет keyring).
    seed(secretsPath(), '# секреты goose\nOPENAI_API_KEY: sk-foreign\nANTHROPIC_API_KEY: sk-ant-foreign\n');

    const result = await gooseAdapter.apply(input());

    const secrets = readYaml(secretsPath());
    expect(secrets.OPENAI_API_KEY).toBe('sk-foreign');
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-ant-foreign');
    expect(secrets.CUSTOM_JOINGONKA_API_KEY).toBe('jg-test123');
    expect(readFileSync(secretsPath(), 'utf-8')).toContain('# секреты goose');
    expect(backupsIn(configDir(), 'secrets.yaml').length).toBe(1);
    // Честная оговорка: если keyring перехватил хранение, файл Goose не прочитает.
    expect(result.messages.join('\n')).toContain('goose configure');
  });

  it('replaces a stale key of ours', async () => {
    seed(secretsPath(), 'CUSTOM_JOINGONKA_API_KEY: jg-old\n');
    await gooseAdapter.apply(input());
    expect(readFileSync(secretsPath(), 'utf-8')).not.toContain('jg-old');
    expect(readYaml(secretsPath()).CUSTOM_JOINGONKA_API_KEY).toBe('jg-test123');
  });

  it.runIf(posix)('writes secrets.yaml with 0o600, tightening an open file', async () => {
    seed(secretsPath(), 'OPENAI_API_KEY: sk-foreign\n');
    await gooseAdapter.apply(input());
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
  });
});

describe('gooseAdapter.apply — отказ без записи', () => {
  const expectNothingWritten = () => {
    expect(backupsIn(configDir(), 'config.yaml')).toEqual([]);
    expect(backupsIn(configDir(), 'secrets.yaml')).toEqual([]);
    expect(backupsIn(join(configDir(), 'custom_providers'), 'custom_joingonka.json')).toEqual([]);
  };

  it('refuses on a broken provider file', async () => {
    seed(providerPath(), '{ broken');
    await expect(gooseAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(providerPath(), 'utf-8')).toBe('{ broken');
    expect(existsSync(configPath())).toBe(false);
    expectNothingWritten();
  });

  it('refuses on a provider file with comments: Goose читает его СТРОГИМ JSON', async () => {
    // serde_json комментариев не понимает, а один нечитаемый файл ломает Goose
    // загрузку ВСЕХ custom_providers — молча «сохранить комментарий» нельзя.
    const text = '{\n  // мой провайдер\n  "name": "custom_joingonka"\n}\n';
    seed(providerPath(), text);
    await expect(gooseAdapter.apply(input())).rejects.toThrow(/strict JSON[\s\S]*Nothing was written/);
    expect(readFileSync(providerPath(), 'utf-8')).toBe(text);
    expectNothingWritten();
  });

  it('refuses on broken config.yaml BEFORE creating the provider file', async () => {
    const broken = 'providers:\n  openai: [unclosed\n  token: sk-foreign-secret\n';
    seed(configPath(), broken);

    const error = await gooseAdapter.apply(input()).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/Nothing was written/);
    expect((error as Error).message).not.toContain('sk-foreign-secret');
    expect(existsSync(providerPath())).toBe(false);
    expect(readFileSync(configPath(), 'utf-8')).toBe(broken);
    expectNothingWritten();
  });

  it('refuses on broken secrets.yaml, leaking nothing from it', async () => {
    const broken = 'OPENAI_API_KEY: [unclosed\nOTHER: sk-foreign-secret\n';
    seed(secretsPath(), broken);

    const error = await gooseAdapter.apply(input()).catch((e: Error) => e);

    expect((error as Error).message).toMatch(/Nothing was written/);
    expect((error as Error).message).not.toContain('sk-foreign-secret');
    expect(existsSync(providerPath())).toBe(false);
    expect(readFileSync(secretsPath(), 'utf-8')).toBe(broken);
    expectNothingWritten();
  });

  it('refuses when `providers` in config.yaml is not a mapping', async () => {
    seed(configPath(), 'providers:\n  - openai\n');
    await expect(gooseAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(existsSync(providerPath())).toBe(false);
  });

  it('refuses when the root of config.yaml is not a mapping', async () => {
    seed(configPath(), '- just\n- a list\n');
    await expect(gooseAdapter.apply(input())).rejects.toThrow(/Nothing was written/);
    expect(existsSync(providerPath())).toBe(false);
  });
});

describe('gooseAdapter.apply — модель по умолчанию: плоская (старая) раскладка', () => {
  it('writes GOOSE_PROVIDER / GOOSE_MODEL into a fresh config (их читает любой Goose)', async () => {
    const result = await gooseAdapter.apply(input());

    const cfg = readYaml(configPath());
    expect(cfg.GOOSE_PROVIDER).toBe('custom_joingonka');
    expect(cfg.GOOSE_MODEL).toBe(DEEPSEEK_MODEL);
    expect(cfg.active_provider).toBeUndefined();
    expect(cfg.providers).toBeUndefined();
    expect(result.messages.join('\n')).toContain(DEEPSEEK_MODEL);
  });

  it('keeps a FOREIGN provider untouched (byte-identical, no backup) without --model', async () => {
    const text = '# мой goose\nGOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-5\nGOOSE_MODE: auto\n';
    seed(configPath(), text);

    const result = await gooseAdapter.apply(input());

    expect(readFileSync(configPath(), 'utf-8')).toBe(text);
    expect(backupsIn(configDir(), 'config.yaml')).toEqual([]);
    const joined = result.messages.join('\n');
    expect(joined).toContain('anthropic');
    expect(joined).toContain('--provider custom_joingonka');
  });

  it('writes an EXPLICIT model over a foreign provider, keeping the rest', async () => {
    seed(configPath(), '# мой goose\nGOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-5\nGOOSE_MODE: auto\n');

    await gooseAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));

    const cfg = readYaml(configPath());
    expect(cfg.GOOSE_PROVIDER).toBe('custom_joingonka');
    expect(cfg.GOOSE_MODEL).toBe(GLM_MODEL);
    expect(cfg.GOOSE_MODE).toBe('auto');
    expect(cfg.active_provider).toBeUndefined();
    expect(readFileSync(configPath(), 'utf-8')).toContain('# мой goose');
    expect(backupsIn(configDir(), 'config.yaml').length).toBe(1);
  });

  it('keeps OUR current model and replaces OUR stale one', async () => {
    seed(configPath(), `GOOSE_PROVIDER: custom_joingonka\nGOOSE_MODEL: ${GLM_MODEL}\n`);
    await gooseAdapter.apply(input());
    expect(readYaml(configPath()).GOOSE_MODEL).toBe(GLM_MODEL);

    seed(configPath(), 'GOOSE_PROVIDER: custom_joingonka\nGOOSE_MODEL: moonshotai/Kimi-K2.6\n');
    await gooseAdapter.apply(input());
    expect(readYaml(configPath()).GOOSE_MODEL).toBe(DEEPSEEK_MODEL);
  });
});

describe('gooseAdapter.apply — переменные окружения перекрывают config.yaml', () => {
  it('warns when GOOSE_PROVIDER / GOOSE_MODEL in the environment would override what we wrote', async () => {
    process.env.GOOSE_PROVIDER = 'anthropic';
    process.env.GOOSE_MODEL = 'claude-sonnet-4-5';

    const result = await gooseAdapter.apply(input());

    expect(readYaml(configPath()).GOOSE_PROVIDER).toBe('custom_joingonka'); // конфиг всё равно пишем
    const joined = result.messages.join('\n');
    expect(joined).toMatch(/GOOSE_PROVIDER.*GOOSE_MODEL|environment/);
    expect(joined).toContain('override');
  });

  it('stays silent when the environment does not interfere', async () => {
    const result = await gooseAdapter.apply(input());
    expect(result.messages.join('\n')).not.toContain('override');
  });
});

describe('gooseAdapter.apply — модель по умолчанию: блок providers (новая раскладка)', () => {
  const structured = (active: string, extra = '') =>
    [
      '# мой goose',
      `active_provider: ${active}`,
      'providers:',
      '  anthropic: # основной',
      '    enabled: true',
      '    model: claude-sonnet-4-5',
      '    configured: true',
      extra,
      'GOOSE_MODE: auto',
    ]
      .filter((line) => line !== '')
      .join('\n') + '\n';

  it('keeps a FOREIGN active provider untouched (byte-identical) without --model', async () => {
    const text = structured('anthropic');
    seed(configPath(), text);

    await gooseAdapter.apply(input());

    expect(readFileSync(configPath(), 'utf-8')).toBe(text);
    expect(backupsIn(configDir(), 'config.yaml')).toEqual([]);
  });

  it('writes an EXPLICIT model the way Goose itself does (set_active_provider)', async () => {
    seed(configPath(), structured('anthropic'));

    await gooseAdapter.apply(input({ model: GLM_MODEL, modelExplicit: true }));

    const cfg = readYaml(configPath());
    expect(cfg.active_provider).toBe('custom_joingonka');
    expect(cfg.providers.custom_joingonka).toEqual({ enabled: true, model: GLM_MODEL, configured: true });
    // чужая запись цела: Goose запоминает модель каждого провайдера
    expect(cfg.providers.anthropic).toEqual({ enabled: true, model: 'claude-sonnet-4-5', configured: true });
    // плоские ключи в новой раскладке не заводим — Goose их сам вычищает
    expect(cfg.GOOSE_PROVIDER).toBeUndefined();
    expect(cfg.GOOSE_MODEL).toBeUndefined();
    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw).toContain('# мой goose');
    expect(raw).toContain('# основной');
  });

  it('keeps OUR current model', async () => {
    const text = structured(
      'custom_joingonka',
      `  custom_joingonka:\n    enabled: true\n    model: ${GLM_MODEL}\n    configured: true`,
    );
    seed(configPath(), text);
    await gooseAdapter.apply(input());
    expect(readFileSync(configPath(), 'utf-8')).toBe(text);
  });

  it('replaces OUR stale model (Kimi K2.6 ушла из сети)', async () => {
    seed(
      configPath(),
      structured(
        'custom_joingonka',
        '  custom_joingonka:\n    enabled: true\n    model: moonshotai/Kimi-K2.6\n    configured: true',
      ),
    );
    await gooseAdapter.apply(input());
    const cfg = readYaml(configPath());
    expect(cfg.providers.custom_joingonka.model).toBe(DEEPSEEK_MODEL);
    expect(cfg.providers.anthropic.model).toBe('claude-sonnet-4-5');
  });

  it('fills the model when our provider is active but has none', async () => {
    seed(configPath(), structured('custom_joingonka'));
    await gooseAdapter.apply(input());
    const cfg = readYaml(configPath());
    expect(cfg.active_provider).toBe('custom_joingonka');
    expect(cfg.providers.custom_joingonka.model).toBe(DEEPSEEK_MODEL);
  });

  it('activates us when the providers block exists but nothing is active', async () => {
    seed(configPath(), 'providers:\n  anthropic:\n    enabled: true\n    model: claude-sonnet-4-5\n    configured: true\n');
    await gooseAdapter.apply(input());
    const cfg = readYaml(configPath());
    expect(cfg.active_provider).toBe('custom_joingonka');
    expect(cfg.providers.custom_joingonka.model).toBe(DEEPSEEK_MODEL);
    expect(cfg.GOOSE_PROVIDER).toBeUndefined();
  });
});

describe('gooseAdapter.apply — backups & idempotency', () => {
  it('backs up an existing provider file and reports no backup for a new one', async () => {
    const fresh = await gooseAdapter.apply(input());
    expect(fresh.backupPath).toBeNull();

    const again = await gooseAdapter.apply(input());
    expect(again.backupPath).not.toBeNull();
  });

  it('is byte-identical on a second apply (all three files)', async () => {
    process.env.GOOSE_DISABLE_KEYRING = '1';
    seed(configPath(), '# мой goose\nGOOSE_MODE: auto\n');
    seed(secretsPath(), '# секреты\nOPENAI_API_KEY: sk-foreign\n');

    await gooseAdapter.apply(input());
    const first = [providerPath(), configPath(), secretsPath()].map((p) => readFileSync(p, 'utf-8'));

    await gooseAdapter.apply(input());
    const second = [providerPath(), configPath(), secretsPath()].map((p) => readFileSync(p, 'utf-8'));

    expect(second).toEqual(first);
  });

  it('writes everything under GOOSE_PATH_ROOT when it is set', async () => {
    const root = join(tmpDir, 'goose-root');
    process.env.GOOSE_PATH_ROOT = root;
    process.env.GOOSE_DISABLE_KEYRING = '1';

    const result = await gooseAdapter.apply(input());

    expect(result.configPath).toBe(join(root, 'config', 'custom_providers', 'custom_joingonka.json'));
    expect(existsSync(join(root, 'config', 'config.yaml'))).toBe(true);
    expect(existsSync(join(root, 'config', 'secrets.yaml'))).toBe(true);
    expect(existsSync(configDir())).toBe(false);
  });
});
