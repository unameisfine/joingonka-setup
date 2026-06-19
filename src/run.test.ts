/**
 * Тесты оркестратора run().
 *
 * run() склеивает: выбор адаптера (по --tool или интерактивно) → получение
 * ключа (из env в non-interactive, иначе password-промпт) → adapter.apply().
 *
 * Чтобы тестировать без живых промптов и без записи в реальный HOME:
 * - prompt-функции инъектируются через deps (askTool/askApiKey) — в тестах
 *   это spy-функции vitest;
 * - сам apply каждого адаптера мокается через подмену registry? Нет —
 *   проще проверять побочный эффект (apply вызван) и решение по выбору.
 *
 * Здесь мы подменяем deps и сам адаптер не трогаем, а проверяем что run
 * вернул результат нужного адаптера и что промпт выбора НЕ дёргался в
 * non-interactive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.js';
import type { RunDeps } from './run.js';

let tmpDir: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalEnvKey: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'joingonka-run-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  originalEnvKey = process.env.JOINGONKA_API_KEY;
  delete process.env.JOINGONKA_API_KEY;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalEnvKey === undefined) delete process.env.JOINGONKA_API_KEY;
  else process.env.JOINGONKA_API_KEY = originalEnvKey;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Фабрика deps со spy-промптами. */
function makeDeps(overrides?: Partial<RunDeps>): RunDeps {
  return {
    askTool: vi.fn(async () => 'claude-code'),
    askApiKey: vi.fn(async () => 'jg-from-prompt'),
    ...overrides,
  };
}

describe('run — non-interactive', () => {
  it('does NOT call the tool select when --tool is given', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();

    await run({ tool: 'openclaw', nonInteractive: true, scope: 'user' }, deps);

    expect(deps.askTool).not.toHaveBeenCalled();
  });

  it('takes the API key from JOINGONKA_API_KEY env (not from prompt)', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();

    const result = await run(
      { tool: 'openclaw', nonInteractive: true, scope: 'user' },
      deps,
    );

    expect(deps.askApiKey).not.toHaveBeenCalled();
    // Ключ из env реально дошёл до адаптера и записан в конфиг
    expect(result.result.wrote).toBe(true);
  });

  it('throws a clear error for an unknown --tool', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();

    await expect(
      run({ tool: 'foo', nonInteractive: true, scope: 'user' }, deps),
    ).rejects.toThrow(/unknown tool|foo/i);
  });

  it('throws when non-interactive but no env key present', async () => {
    // JOINGONKA_API_KEY удалён в beforeEach
    const deps = makeDeps();
    await expect(
      run({ tool: 'openclaw', nonInteractive: true, scope: 'user' }, deps),
    ).rejects.toThrow(/JOINGONKA_API_KEY/);
  });

  it('rejects an invalid env key (must start with jg-)', async () => {
    process.env.JOINGONKA_API_KEY = 'not-a-jg-key';
    const deps = makeDeps();
    await expect(
      run({ tool: 'openclaw', nonInteractive: true, scope: 'user' }, deps),
    ).rejects.toThrow(/jg-/);
  });
});

describe('run — interactive', () => {
  it('prompts for tool and key, then applies the chosen adapter once', async () => {
    const deps = makeDeps({
      askTool: vi.fn(async () => 'claude-code'),
      askApiKey: vi.fn(async () => 'jg-interactive'),
    });

    const result = await run({ scope: 'user' }, deps);

    expect(deps.askTool).toHaveBeenCalledTimes(1);
    expect(deps.askApiKey).toHaveBeenCalledTimes(1);
    expect(result.toolId).toBe('claude-code');
    expect(result.result.wrote).toBe(true);
  });

  it('passes the explicit --tool through without prompting for it', async () => {
    const deps = makeDeps({ askApiKey: vi.fn(async () => 'jg-interactive') });

    const result = await run({ tool: 'cline', scope: 'user' }, deps);

    expect(deps.askTool).not.toHaveBeenCalled();
    // Cline — instructions-only: ничего не пишет
    expect(result.toolId).toBe('cline');
    expect(result.result.wrote).toBe(false);
  });
});

describe('run — model selection', () => {
  it('uses the default model when none specified', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();
    const result = await run(
      { tool: 'cline', nonInteractive: true, scope: 'user' },
      deps,
    );
    expect(result.result.messages.join('\n')).toContain(
      'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8',
    );
  });

  it('maps --model kimi to the Kimi model id', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();
    const result = await run(
      { tool: 'cline', model: 'kimi', nonInteractive: true, scope: 'user' },
      deps,
    );
    expect(result.result.messages.join('\n')).toContain('moonshotai/Kimi-K2.6');
  });
});
