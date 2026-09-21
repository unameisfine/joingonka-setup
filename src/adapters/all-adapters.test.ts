/**
 * Сквозные свойства ВСЕХ адаптеров реестра.
 *
 * У каждого адаптера есть свой набор тестов, но каноны установщика общие, и
 * новый адаптер обязан выполнять их с первого дня — поэтому здесь они проверяются
 * циклом по реестру, а не списком имён: инструмент, добавленный завтра, попадает
 * под гейт сам.
 *   - пишущий адаптер пишет ТОЛЬКО внутрь домашнего каталога, файл с ключом —
 *     0o600, повторный запуск ничего не меняет;
 *   - адаптер-инструкция не создаёт на диске ничего;
 *   - каждый вызов applyJsonEdits получает путь файла: без него в отказе вместо
 *     пути стоит безликое «The config file:» (так было у пяти адаптеров 0.5.0 до
 *     интеграции; в сигнатуре путь теперь обязателен, этот тест — страховка для
 *     вызовов в обход типов);
 *   - модель live-проверки совпадает с моделью, которую адаптер пишет дефолтом.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { adapters, toolIds } from './registry.js';
import { applyJsonEdits } from '../core/json-config.js';
import { CODING_AGENT_DEFAULT_MODEL, DEFAULT_MODEL } from '../constants.js';

// Мокаем ровно тот модуль, который импортируют адаптеры: оригинал остаётся
// рабочим, добавляется только запись аргументов.
vi.mock('../core/json-config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/json-config.js')>();
  return { ...mod, applyJsonEdits: vi.fn(mod.applyJsonEdits) };
});

/** Всё, чем инструменты и адаптеры переносят свои каталоги, — вон из окружения теста. */
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CODEX_HOME',
  'CRUSH_GLOBAL_CONFIG',
  'CRUSH_GLOBAL_DATA',
  'GOOSE_PATH_ROOT',
  'GOOSE_DISABLE_KEYRING',
  'GOOSE_PROVIDER',
  'GOOSE_MODEL',
  'HERMES_HOME',
  'JOINGONKA_API_KEY',
  'KILO_CONFIG',
  'KIMI_CODE_HOME',
  'MAVIS_DATA_DIR',
  'MIMOCODE_CONFIG',
  'MIMOCODE_HOME',
  'MINIMAX_DATA_DIR',
  'OMP_PROFILE',
  'OPENCLAW_CONFIG_PATH',
  'OPENCODE_AUTH_JSON',
  'OPENCODE_CONFIG',
  'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR',
  'PI_PROFILE',
  'QWEN_HOME',
] as const;

const API_KEY = 'jg-0123456789abcdef0123456789abcdef';

let home: string;
let originalCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'joingonka-all-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = home;
  originalCwd = process.cwd();
  process.chdir(home);
  vi.mocked(applyJsonEdits).mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

/** Все файлы песочницы: относительный путь → содержимое. */
function snapshot(dir = home, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, text] of snapshot(join(dir, entry.name), rel)) files.set(name, text);
    } else {
      files.set(rel, readFileSync(join(dir, entry.name), 'utf-8'));
    }
  }
  return files;
}

const withoutBackups = (files: Map<string, string>) =>
  new Map([...files].filter(([name]) => !name.includes('.bak.')));

const writers = toolIds().filter((id) => adapters[id].format !== 'instructions');
const printers = toolIds().filter((id) => adapters[id].format === 'instructions');

/** Вход оркестратора без `--model`: пер-инструментный дефолт. */
const defaultInput = (id: (typeof writers)[number]) => ({
  apiKey: API_KEY,
  model: adapters[id].defaultModel ?? DEFAULT_MODEL,
  scope: 'user' as const,
  modelExplicit: false,
});

describe('every adapter that writes a config', () => {
  it('is the larger part of the registry', () => {
    expect(writers.length).toBeGreaterThanOrEqual(16);
    expect(writers.length + printers.length).toBe(toolIds().length);
  });

  it.each(writers)('%s: writes inside the home directory and reports the file', async (id) => {
    const result = await adapters[id].apply(defaultInput(id));

    expect(result.wrote).toBe(true);
    expect(result.configPath).toEqual(expect.any(String));
    expect(result.configPath!.startsWith(home)).toBe(true);
    expect(adapters[id].resolvePath('user')).toBe(result.configPath);
    expect(snapshot().size).toBeGreaterThan(0);
    // Свежая установка: бэкапить было нечего.
    expect(result.backupPath).toBeNull();
  });

  it.each(writers)('%s: keeps every file that holds the API key owner-only', async (id) => {
    if (platform() === 'win32') return; // POSIX-права на Windows не применяются
    await adapters[id].apply(defaultInput(id));

    for (const [name, text] of snapshot()) {
      if (!text.includes(API_KEY)) continue;
      expect(statSync(join(home, name)).mode & 0o777, `${id}: ${name}`).toBe(0o600);
    }
  });

  it.each(writers)('%s: a second run changes nothing', async (id) => {
    await adapters[id].apply(defaultInput(id));
    const first = withoutBackups(snapshot());

    await adapters[id].apply(defaultInput(id));

    expect(withoutBackups(snapshot())).toEqual(first);
  });

  it.each(writers)('%s: names the file in every applyJsonEdits call', async (id) => {
    await adapters[id].apply(defaultInput(id));
    // Явная модель ведёт некоторые адаптеры во второй файл (Crush — файл состояния).
    await adapters[id].apply({ ...defaultInput(id), model: DEFAULT_MODEL, modelExplicit: true });

    for (const call of vi.mocked(applyJsonEdits).mock.calls) {
      const filePath = call[2];
      expect(filePath, `${id}: applyJsonEdits without a file path`).toEqual(expect.any(String));
      expect(filePath.startsWith(home), `${id}: ${filePath}`).toBe(true);
    }
  });
});

describe('every adapter that prints instructions', () => {
  it.each(printers)('%s: writes nothing to disk', async (id) => {
    const result = await adapters[id].apply({
      apiKey: API_KEY,
      model: DEFAULT_MODEL,
      scope: 'user',
      modelExplicit: false,
    });

    expect(result.wrote).toBe(false);
    expect(result.configPath).toBeNull();
    expect(result.backupPath).toBeNull();
    expect(adapters[id].resolvePath('user')).toBeNull();
    expect(snapshot().size).toBe(0);
    // Инструкция без ключа, адреса и модели бесполезна.
    const text = result.messages.join('\n');
    expect(text).toContain(API_KEY);
    expect(text).toContain('https://gate.joingonka.ai');
    expect(text).toContain(DEFAULT_MODEL);
  });
});

describe('default model: what is verified is what is written', () => {
  // ★ Оркестратор проверяет живым запросом `adapter.defaultModel ?? DEFAULT_MODEL`.
  // Пока у openclaw / opencode / kilo поля не было, в конфиг уходил DeepSeek, а
  // «Verified» выдавалось за MiniMax. Правило реестра: адаптер, который ПИШЕТ
  // модель по умолчанию, объявляет дефолт кодовых агентов.
  //
  // Исключение одно: Zed. Без `--model` он пишет только провайдера и каталог, а
  // модель человек выбирает в панели агента — поэтому подсказка и проверка у него
  // идут по общему DEFAULT_MODEL, как у печатных инструкций.
  const NO_DEFAULT_WRITTEN = ['zed'];

  it.each(writers.filter((id) => !NO_DEFAULT_WRITTEN.includes(id)))(
    '%s declares the coding-agent default',
    (id) => {
      expect(adapters[id].defaultModel).toBe(CODING_AGENT_DEFAULT_MODEL);
    },
  );

  it.each(writers.filter((id) => !NO_DEFAULT_WRITTEN.includes(id)))(
    '%s reports that very model as the default it configured',
    async (id) => {
      const { messages } = await adapters[id].apply(defaultInput(id));
      const text = messages.join('\n');
      expect(text).toContain(CODING_AGENT_DEFAULT_MODEL);
      // Ни одна строка не выдаёт другую модель каталога за дефолт.
      expect(text).not.toMatch(new RegExp(`(Default|Large) model: \\S*${DEFAULT_MODEL}`));
    },
  );

  it('zed and the printed instructions stay on the general default', () => {
    for (const id of [...NO_DEFAULT_WRITTEN, ...printers] as const) {
      expect(adapters[id as (typeof writers)[number]].defaultModel, id).toBeUndefined();
    }
  });
});
