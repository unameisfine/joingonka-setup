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
 *   свежий конфиг (бэкап уже сделан);
 * - бэкап при наличии файла, идемпотентность, HERMES_HOME, chmod 600.
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
import { hermesAdapter } from './hermes.js';
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

  it('starts fresh (with backup) when the root is not a map', async () => {
    seedConfig('- just\n- a list\n');

    await hermesAdapter.apply(input());

    expect(readConfig().model.provider).toBe('custom');
    const backups = readdirSync(join(tmpDir, '.hermes')).filter((f) =>
      f.startsWith('config.yaml.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it('handles malformed YAML by starting fresh and backing up', async () => {
    seedConfig('model: [unclosed\n  broken: yes\n');

    await hermesAdapter.apply(input());

    expect(readConfig().model.provider).toBe('custom');
    const backups = readdirSync(join(tmpDir, '.hermes')).filter((f) =>
      f.startsWith('config.yaml.bak.'),
    );
    expect(backups.length).toBeGreaterThan(0);
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
