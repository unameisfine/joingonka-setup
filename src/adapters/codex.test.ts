/**
 * Контракт-тесты адаптера Codex CLI (~/.codex/config.toml).
 *
 * Изоляция — подменой HOME и настоящей переменной инструмента CODEX_HOME.
 *
 * Проверяем: пути, формат файла (golden), ключ ЛИТЕРАЛОМ в таблице провайдера,
 * реальные окна контекста, сохранность чужих таблиц и КОММЕНТАРИЕВ, правила
 * дефолтной модели (чужой выбор, наша устаревшая, явный --model), отказ без
 * записи и без бэкапа (битый TOML, неподдерживаемая форма нашего блока), права
 * 0o600, идемпотентность байт-в-байт.
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
  chmodSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from 'smol-toml';
import { codexAdapter, codexConfigPath } from './codex.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL, GLM_MODEL } from '../constants.js';

const ENV_KEYS = ['HOME', 'CODEX_HOME'] as const;
const GATE = 'https://gate.joingonka.ai/v1';

let tmpDir: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-codex-'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = tmpDir;
  configPath = join(tmpDir, '.codex', 'config.toml');
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
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
}
const readText = (): string => readFileSync(configPath, 'utf-8');
const readConfig = (): any => parse(readText());
const backups = (): string[] =>
  existsSync(dirname(configPath))
    ? readdirSync(dirname(configPath)).filter((name) => name.includes('.bak.'))
    : [];

describe('codexAdapter — метаданные', () => {
  it('is a writing TOML adapter for a coding agent', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(codexAdapter.format).toBe('toml');
    expect(codexAdapter.apiMode).toBe('openai');
    expect(codexAdapter.defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    // Проектный .codex/config.toml выбрать провайдера не может — Codex игнорирует там model_provider.
    expect(codexAdapter.supportsLocalScope).toBeFalsy();
    expect(codexAdapter.wantsPricing).toBeFalsy();
  });
});

describe('codexAdapter.resolvePath', () => {
  it('defaults to ~/.codex/config.toml for both scopes', () => {
    expect(codexAdapter.resolvePath('user')).toBe(configPath);
    expect(codexAdapter.resolvePath('local')).toBe(configPath);
  });

  it('honours CODEX_HOME (a directory replacing ~/.codex)', () => {
    process.env.CODEX_HOME = join(tmpDir, 'custom-codex');
    expect(codexAdapter.resolvePath('user')).toBe(join(tmpDir, 'custom-codex', 'config.toml'));
  });

  it('ignores an empty CODEX_HOME the way Codex does', () => {
    process.env.CODEX_HOME = '';
    expect(codexAdapter.resolvePath('user')).toBe(configPath);
  });

  it('uses %USERPROFILE%\\.codex on Windows', () => {
    expect(codexConfigPath({ platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\.codex\\config.toml',
    );
  });
});

describe('codexAdapter.apply — чистая установка', () => {
  it('writes exactly the documented provider and default (golden)', async () => {
    const result = await codexAdapter.apply(input);
    expect(readText()).toBe(
      [
        `model = "${CODING_AGENT_DEFAULT_MODEL}"`,
        'model_provider = "joingonka"',
        'model_context_window = 380000',
        '',
        '[model_providers.joingonka]',
        'name = "JoinGonka"',
        `base_url = "${GATE}"`,
        'wire_api = "responses"',
        'experimental_bearer_token = "jg-test123"',
        '',
      ].join('\n'),
    );
    expect(result.wrote).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBeNull();
  });

  it('puts the API key into the config literally and never points at an env variable', async () => {
    const result = await codexAdapter.apply(input);
    const provider = readConfig().model_providers.joingonka;
    expect(provider.experimental_bearer_token).toBe('jg-test123');
    // env_key без переменной в окружении — отказ Codex ещё до литерального токена.
    expect(provider).not.toHaveProperty('env_key');
    const text = result.messages.join('\n');
    expect(text).toContain('experimental_bearer_token');
    expect(text).not.toContain('jg-test123'); // значение ключа в сообщениях не повторяем
    expect(text).not.toMatch(/export /);
  });

  it('never names the provider "OpenAI" — that name switches Codex to remote compaction', async () => {
    await codexAdapter.apply(input);
    expect(readConfig().model_providers.joingonka.name).toBe('JoinGonka');
  });

  it.each([
    [DEFAULT_MODEL, 200000],
    [GLM_MODEL, 390000],
  ])('writes the real context window of %s', async (model, window) => {
    await codexAdapter.apply({ ...input, model, modelExplicit: true });
    const config = readConfig();
    expect(config.model).toBe(model);
    expect(config.model_context_window).toBe(window);
  });

  it('warns that Codex caps the window of a model it has no metadata for', async () => {
    const result = await codexAdapter.apply(input);
    expect(result.messages.join('\n')).toContain('272000');
  });

  it('gives an out-of-catalog explicit model a conservative window', async () => {
    await codexAdapter.apply({ ...input, model: 'vendor/brand-new', modelExplicit: true });
    const config = readConfig();
    expect(config.model).toBe('vendor/brand-new');
    expect(config.model_context_window).toBe(200000);
  });

  it.skipIf(platform() === 'win32')('writes the file with mode 0o600, also over a wider one', async () => {
    seed('# mine\n');
    chmodSync(configPath, 0o644);
    await codexAdapter.apply(input);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second run leaves the file byte-identical', async () => {
    await codexAdapter.apply(input);
    const first = readText();
    const second = await codexAdapter.apply(input);
    expect(readText()).toBe(first);
    expect(second.backupPath).toMatch(/config\.toml\.bak\./);
  });
});

describe('codexAdapter.apply — чужой конфиг', () => {
  const FOREIGN = [
    '# Codex — настроено руками',
    'model = "gpt-5.6-terra"          # основной',
    'model_provider = "azure"',
    'model_context_window = 128000    # мой лимит',
    "approval_policy = 'on-request'",
    '',
    '# Azure — рабочий провайдер',
    '[model_providers.azure]',
    'name = "Azure"',
    'base_url = "https://corp.openai.azure.com/openai"',
    'env_key = "AZURE_OPENAI_API_KEY"   # не трогать',
    'query_params = { api-version = "2025-04-01-preview" }',
    '',
    '[mcp_servers.docs]',
    'command = "npx"',
    'args = [',
    '  "-y",          # без вопросов',
    '  "docs-mcp",',
    ']',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = "^Bash$"',
    '',
  ].join('\n');

  it('adds our provider and keeps every foreign line, comment and table', async () => {
    seed(FOREIGN);
    await codexAdapter.apply(input);
    const text = readText();
    // Всё чужое — байт-в-байт в начале файла; наше дописано в конец.
    expect(text.startsWith(FOREIGN)).toBe(true);
    expect(text.slice(FOREIGN.length)).toBe(
      [
        '',
        '[model_providers.joingonka]',
        'name = "JoinGonka"',
        `base_url = "${GATE}"`,
        'wire_api = "responses"',
        'experimental_bearer_token = "jg-test123"',
        '',
      ].join('\n'),
    );
  });

  it('keeps a foreign default and tells how to try JoinGonka for one session', async () => {
    seed(FOREIGN);
    const result = await codexAdapter.apply(input);
    const config = readConfig();
    expect(config.model).toBe('gpt-5.6-terra');
    expect(config.model_provider).toBe('azure');
    expect(config.model_context_window).toBe(128000);
    const text = result.messages.join('\n');
    expect(text).toContain('azure');
    expect(text).toContain('-c model_provider=joingonka');
    expect(text).toContain(`-m ${CODING_AGENT_DEFAULT_MODEL}`);
  });

  it('keeps a model chosen for the built-in OpenAI provider (no model_provider line)', async () => {
    seed('model = "gpt-5.6-sol"\n');
    await codexAdapter.apply(input);
    const config = readConfig();
    expect(config.model).toBe('gpt-5.6-sol');
    expect(config).not.toHaveProperty('model_provider');
    expect(config).not.toHaveProperty('model_context_window');
    expect(config.model_providers.joingonka.base_url).toBe(GATE);
  });

  it('makes JoinGonka the default when the file selects nothing yet, and says how to undo it', async () => {
    seed('# only MCP so far\n[mcp_servers.docs]\ncommand = "npx"\n');
    const result = await codexAdapter.apply(input);
    // Встроенный OpenAI-провайдер до установки действовал неявно — говорим, как к нему вернуться.
    expect(result.messages.join('\n')).toMatch(/built-in OpenAI.*delete the model, model_provider/s);
    const config = readConfig();
    expect(config.model).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(config.model_provider).toBe('joingonka');
    expect(readText()).toContain('# only MCP so far\n[mcp_servers.docs]');
  });

  it('writes an explicit --model over a foreign default and says how to go back', async () => {
    seed(FOREIGN);
    const result = await codexAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    const config = readConfig();
    expect(config.model).toBe(GLM_MODEL);
    expect(config.model_provider).toBe('joingonka');
    expect(config.model_context_window).toBe(390000);
    // Правится только значение: комментарии пользователя на тех же строках целы.
    expect(readText()).toContain(`model = "${GLM_MODEL}"          # основной`);
    expect(readText()).toContain('model_context_window = 390000    # мой лимит');

    const text = result.messages.join('\n');
    expect(text).toContain('azure'); // что было
    expect(text).toContain('gpt-5.6-terra');
    expect(text).toMatch(/config\.toml\.bak\./); // как вернуть
  });

  it('points out a review_model that would now be sent to JoinGonka', async () => {
    seed('model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-sol"\n');
    const result = await codexAdapter.apply({ ...input, modelExplicit: true });
    expect(readConfig().review_model).toBe('gpt-5.6-sol'); // чужое не трогаем
    expect(result.messages.join('\n')).toContain('review_model');
  });
});

describe('codexAdapter.apply — наш прежний конфиг', () => {
  it('resets our retired default model (seeded Kimi K2.6) and cleans review_model', async () => {
    seed(
      [
        'model = "moonshotai/Kimi-K2.6"',
        'model_provider = "joingonka"',
        'review_model = "moonshotai/Kimi-K2.6"',
        'model_context_window = 262144',
        '',
        '[model_providers.joingonka]',
        'name = "JoinGonka"',
        `base_url = "${GATE}"`,
        '',
      ].join('\n'),
    );
    const result = await codexAdapter.apply(input);
    const config = readConfig();
    expect(config.model).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(config.review_model).toBe(CODING_AGENT_DEFAULT_MODEL);
    expect(config.model_context_window).toBe(380000);
    expect(readText()).not.toContain('Kimi');
    expect(result.messages.join('\n')).toMatch(/no longer served/);
  });

  it('switches between two live models of ours without calling the old one retired', async () => {
    seed(`model = "${DEFAULT_MODEL}"\nmodel_provider = "joingonka"\nmodel_context_window = 200000\n`);
    const result = await codexAdapter.apply({ ...input, model: GLM_MODEL, modelExplicit: true });
    const config = readConfig();
    expect(config.model).toBe(GLM_MODEL);
    expect(config.model_context_window).toBe(390000);
    const text = result.messages.join('\n');
    expect(text).not.toMatch(/no longer serve/);
    expect(text).not.toMatch(/go back/i); // провайдер и так был наш — возвращать нечего
  });

  it('keeps our own still-served model chosen by the user', async () => {
    seed(`model = "${DEFAULT_MODEL}"\nmodel_provider = "joingonka"\n`);
    const result = await codexAdapter.apply(input);
    const config = readConfig();
    expect(config.model).toBe(DEFAULT_MODEL);
    // Окна не было — ставим реальное для ОСТАВЛЕННОЙ модели, а не для дефолтной.
    expect(config.model_context_window).toBe(200000);
    expect(result.messages.join('\n')).toContain(DEFAULT_MODEL);
  });

  it('lowers a window that exceeds the kept model, but respects a smaller one', async () => {
    seed(`model = "${DEFAULT_MODEL}"\nmodel_provider = "joingonka"\nmodel_context_window = 380000\n`);
    await codexAdapter.apply(input);
    expect(readConfig().model_context_window).toBe(200000);

    seed(`model = "${DEFAULT_MODEL}"\nmodel_provider = "joingonka"\nmodel_context_window = 100000\n`);
    await codexAdapter.apply(input);
    expect(readConfig().model_context_window).toBe(100000);
  });

  it('keeps the user keys and sub-tables of our provider table', async () => {
    seed(
      [
        '[model_providers.joingonka]',
        'name = "my gonka"',
        'stream_idle_timeout_ms = 600000 # медленная сеть',
        '',
        '[model_providers.joingonka.http_headers]',
        'X-Team = "core"',
        '',
      ].join('\n'),
    );
    await codexAdapter.apply(input);
    const provider = readConfig().model_providers.joingonka;
    expect(provider.name).toBe('JoinGonka');
    expect(provider.stream_idle_timeout_ms).toBe(600000);
    expect(provider.http_headers).toEqual({ 'X-Team': 'core' });
    expect(readText()).toContain('stream_idle_timeout_ms = 600000 # медленная сеть');
  });

  it('repairs wire_api = "chat" from old instructions — Codex refuses to load a config with it', async () => {
    seed(`[model_providers.joingonka]\nname = "JoinGonka"\nbase_url = "${GATE}"\nwire_api = "chat"\n`);
    await codexAdapter.apply(input);
    expect(readConfig().model_providers.joingonka.wire_api).toBe('responses');
  });

  it('removes env_key: with it Codex would ignore the literal key or fail on a missing variable', async () => {
    seed(
      [
        '[model_providers.joingonka]',
        'name = "JoinGonka"',
        `base_url = "${GATE}"`,
        'env_key = "JOINGONKA_API_KEY"',
        '',
      ].join('\n'),
    );
    const result = await codexAdapter.apply(input);
    const provider = readConfig().model_providers.joingonka;
    expect(provider).not.toHaveProperty('env_key');
    expect(provider.experimental_bearer_token).toBe('jg-test123');
    expect(result.messages.join('\n')).toContain('env_key');
  });

  it('leaves a command-backed auth alone and does not store the key next to it', async () => {
    seed(
      [
        '[model_providers.joingonka]',
        'name = "JoinGonka"',
        '',
        '[model_providers.joingonka.auth]',
        'command = "/usr/local/bin/gonka-token"',
        '',
      ].join('\n'),
    );
    const result = await codexAdapter.apply(input);
    const provider = readConfig().model_providers.joingonka;
    // Codex отвергает auth вместе с experimental_bearer_token — конфиг перестал бы грузиться.
    expect(provider).not.toHaveProperty('experimental_bearer_token');
    expect(provider.auth).toEqual({ command: '/usr/local/bin/gonka-token' });
    expect(provider.base_url).toBe(GATE);
    expect(result.messages.join('\n')).toMatch(/NOT stored/);
  });
});

describe('codexAdapter.apply — отказ без записи', () => {
  async function expectRefusal(seeded: string, pattern: RegExp): Promise<void> {
    seed(seeded);
    await expect(codexAdapter.apply(input)).rejects.toThrow(pattern);
    await expect(codexAdapter.apply(input)).rejects.toThrow(configPath);
    await expect(codexAdapter.apply(input)).rejects.toThrow(/Nothing was written/);
    expect(readText()).toBe(seeded); // файл не тронут
    expect(backups()).toEqual([]); // и бэкап не создан
  }

  it('refuses a broken TOML file', async () => {
    await expectRefusal('model = "gpt-5.6-terra"\n[model_providers.azure\nname = "x"\n', /not valid TOML/);
  });

  it('refuses our provider written with dotted keys', async () => {
    await expectRefusal(
      'model_providers.joingonka.name = "JoinGonka"\nmodel_providers.joingonka.base_url = "x"\n',
      /model_providers\.joingonka/,
    );
  });

  it('refuses our provider written as an inline table', async () => {
    await expectRefusal(
      '[model_providers]\njoingonka = { name = "JoinGonka", base_url = "x" }\n',
      /model_providers\.joingonka/,
    );
  });

  it('refuses when model_providers itself is inline and cannot be extended', async () => {
    await expectRefusal('model_providers = { azure = { name = "Azure" } }\n', /inline/);
  });

  it('refuses a scalar where the providers table is expected', async () => {
    await expectRefusal('model_providers = "oops"\n', /expected to be a table/);
  });
});
