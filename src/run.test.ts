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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  // verify (по умолчанию вкл.) делает реальный fetch к gate — мокаем, чтобы
  // тесты оркестрации не ходили в сеть.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' }));
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalEnvKey === undefined) delete process.env.JOINGONKA_API_KEY;
  else process.env.JOINGONKA_API_KEY = originalEnvKey;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
      'MiniMaxAI/MiniMax-M2.7',
    );
  });

  it('hermes gets DeepSeek by default: агенту нужен длинный контекст и много раундов', async () => {
    // Пер-инструментный дефолт: у Hermes автономный цикл с длинной историей
    // tool-calling, DeepSeek V4 Flash даёт 380K контекста и потолок ответа 32768
    // против 200K/8192 у остальных. Прочие инструменты остаются на DEFAULT_MODEL.
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();
    const result = await run(
      { tool: 'hermes', nonInteractive: true, scope: 'user' },
      deps,
    );
    expect(result.result.messages.join('\n')).toContain(
      'deepseek-ai/DeepSeek-V4-Flash-0731',
    );
  });

  it('явный --model перекрывает пер-инструментный дефолт', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();
    const result = await run(
      { tool: 'hermes', model: 'glm', nonInteractive: true, scope: 'user' },
      deps,
    );
    const out = result.result.messages.join('\n');
    expect(out).toContain('zai-org/GLM-5.3-Flash');
    expect(out).not.toContain('DeepSeek');
  });

  it('maps --model glm to the GLM model id', async () => {
    process.env.JOINGONKA_API_KEY = 'jg-env-key';
    const deps = makeDeps();
    const result = await run(
      { tool: 'cline', model: 'glm', nonInteractive: true, scope: 'user' },
      deps,
    );
    expect(result.result.messages.join('\n')).toContain('zai-org/GLM-5.3-Flash');
  });
});

describe('run() — модель и область установки (0.4.5)', () => {
  const deps = (): RunDeps => ({
    askTool: vi.fn(),
    askApiKey: vi.fn().mockResolvedValue('jg-test123'),
  });

  it('stops before writing when the model left the network', async () => {
    await expect(
      run({ tool: 'openclaw', model: 'kimi', verify: false }, deps()),
    ).rejects.toThrow(/no longer served/i);
  });

  it('stops on a typo in the model shortcut', async () => {
    await expect(
      run({ tool: 'hermes', model: 'deepsek', verify: false }, deps()),
    ).rejects.toThrow(/Unknown model/i);
  });

  it('refuses --scope local for a tool without a project config', async () => {
    await expect(
      run({ tool: 'openclaw', scope: 'local', verify: false }, deps()),
    ).rejects.toThrow(/--scope local does not apply/);
  });

  it('allows --scope local for claude-code', async () => {
    const outcome = await run({ tool: 'claude-code', scope: 'local', verify: false }, deps());
    expect(outcome.result.configPath).toContain('.claude/settings.local.json');
  });

  it('reports a warning for a model outside the catalog', async () => {
    const outcome = await run(
      { tool: 'openclaw', model: 'newvendor/Model-X', verify: false },
      deps(),
    );
    expect(outcome.modelWarning).toMatch(/not in this installer/i);
  });
});

describe('run() — живые цены (0.4.5)', () => {
  const deps = (): RunDeps => ({
    askTool: vi.fn(),
    askApiKey: vi.fn().mockResolvedValue('jg-test123'),
  });

  /** fetch, который знает про /api/pricing; всё остальное — заглушка verify. */
  const fetchWithPricing = (pricingBody: string | Error) =>
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/pricing')) {
        if (pricingBody instanceof Error) throw pricingBody;
        return { ok: true, status: 200, text: async () => pricingBody };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });

  const openclawCost = () =>
    JSON.parse(readFileSync(join(tmpDir, '.openclaw', 'openclaw.json'), 'utf-8')).models.providers
      .gonka.models[0].cost;

  it('asks the gateway once and hands the price to an adapter that writes prices', async () => {
    const fetchMock = fetchWithPricing(
      JSON.stringify({
        models: [
          {
            model_id: 'MiniMaxAI/MiniMax-M2.7',
            usd_per_million_tokens: 0.004,
            usd_per_million_output: 0.012,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await run({ tool: 'openclaw', verify: false }, deps());

    expect(openclawCost()).toEqual({ input: 0.004, output: 0.012, cacheRead: 0.004, cacheWrite: 0.004 });
    const pricingCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/pricing'));
    expect(pricingCalls).toHaveLength(1);
  });

  it('falls back to the built-in price when the gateway cannot be reached', async () => {
    vi.stubGlobal('fetch', fetchWithPricing(new Error('ENOTFOUND')));

    await run({ tool: 'openclaw', verify: false }, deps());

    expect(openclawCost().input).toBe(0.0062);
    expect(openclawCost().output).toBe(0.0185);
  });

  it('does not go to the network for a tool that has no prices to write', async () => {
    const fetchMock = fetchWithPricing('{}');
    vi.stubGlobal('fetch', fetchMock);

    await run({ tool: 'cline', verify: false }, deps());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('run() — live-проверка идёт по той модели, что записана в конфиг (0.5.0)', () => {
  // ★ Находка аудита. openclaw, opencode и kilo без `--model` писали в конфиг
  // DeepSeek (CODING_AGENT_DEFAULT_MODEL), но `defaultModel` у адаптеров задан не
  // был — оркестратор брал общий DEFAULT_MODEL и проверял живым запросом MiniMax.
  // «✓ Verified» подтверждало не ту модель, с которой инструмент пойдёт в сеть: при
  // недоступном DeepSeek установка рапортовала успех, а агент не работал.
  const DEEPSEEK = 'deepseek-ai/DeepSeek-V4-Flash-0731';
  const MINIMAX = 'MiniMaxAI/MiniMax-M2.7';
  const deps = (): RunDeps => ({
    askTool: vi.fn(),
    askApiKey: vi.fn().mockResolvedValue('jg-test123'),
  });

  // Адаптеры уважают переменные своих инструментов — в тесте их быть не должно,
  // иначе запись уйдёт мимо песочницы HOME.
  const ENV_KEYS = [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'OPENCLAW_CONFIG_PATH',
    'OPENCODE_CONFIG',
    'OPENCODE_AUTH_JSON',
    'KILO_CONFIG',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** Модели, с которыми оркестратор сходил на live-проверку. */
  const verifiedModels = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
    fetchMock.mock.calls
      .filter(([url]) => /\/v1\/(chat\/completions|messages)$/.test(String(url)))
      .map(([, init]) => JSON.parse((init as { body: string }).body).model);

  const json = (...segments: string[]) => JSON.parse(readFileSync(join(tmpDir, ...segments), 'utf-8'));

  /** Модель по умолчанию, которая реально оказалась в конфиге инструмента. */
  const writtenDefault: Record<string, () => string> = {
    openclaw: () => json('.openclaw', 'openclaw.json').agents.defaults.model.primary,
    opencode: () => json('.config', 'opencode', 'opencode.json').model,
    kilo: () => json('.config', 'kilo', 'kilo.jsonc').model,
  };

  it.each(['openclaw', 'opencode', 'kilo'])(
    '%s: without --model the check uses DeepSeek — the model written as the default',
    async (tool) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await run({ tool }, deps());

      expect(outcome.verification?.ok).toBe(true);
      expect(verifiedModels(fetchMock)).toEqual([DEEPSEEK]);
      expect(writtenDefault[tool]!()).toMatch(new RegExp(`/${DEEPSEEK}$`));
    },
  );

  it.each(['openclaw', 'opencode', 'kilo'])(
    '%s: an explicit --model is both written and verified',
    async (tool) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
      vi.stubGlobal('fetch', fetchMock);

      await run({ tool, model: 'minimax' }, deps());

      expect(verifiedModels(fetchMock)).toEqual([MINIMAX]);
      expect(writtenDefault[tool]!()).toMatch(new RegExp(`/${MINIMAX}$`));
    },
  );

  it('keeps the general default for printed instructions and for Zed, which writes no default model', async () => {
    for (const tool of ['cline', 'zoo', 'zed']) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
      vi.stubGlobal('fetch', fetchMock);

      await run({ tool }, deps());

      expect(verifiedModels(fetchMock), tool).toEqual([MINIMAX]);
    }
  });
});

describe('run() — сообщения об ошибках берут список инструментов из реестра (0.5.0)', () => {
  const deps = (): RunDeps => ({
    askTool: vi.fn(),
    askApiKey: vi.fn().mockResolvedValue('jg-test123'),
  });

  it('lists every registered tool for an unknown --tool, the new ones included', async () => {
    const error = await run({ tool: 'nope', verify: false }, deps()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    for (const id of ['claude-code', 'codex', 'goose', 'kimi-code', 'zoo', 'roo']) {
      expect((error as Error).message).toContain(id);
    }
  });

  it('does not mistake a name inherited from Object for a tool', async () => {
    await expect(run({ tool: 'constructor', verify: false }, deps())).rejects.toThrow(/Unknown tool/);
  });

  it('names the tools that do support --scope local', async () => {
    await expect(run({ tool: 'codex', scope: 'local', verify: false }, deps())).rejects.toThrow(
      /--scope local does not apply.*supported for: claude-code/s,
    );
  });
});

describe('run() — live-проверка идёт протоколом инструмента (0.5.0)', () => {
  const deps = (): RunDeps => ({
    askTool: vi.fn(),
    askApiKey: vi.fn().mockResolvedValue('jg-test123'),
  });

  const ENV_KEYS = ['CODEX_HOME'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** Куда и с какой моделью ушла проба. */
  const probes = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith('/api/pricing'))
      .map(([url, init]) => ({
        url: String(url),
        model: JSON.parse((init as { body: string }).body).model as string,
      }));

  it('codex: checks /v1/responses — the only protocol Codex speaks — with the model it wrote', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await run({ tool: 'codex' }, deps());

    expect(outcome.verification?.ok).toBe(true);
    expect(probes(fetchMock)).toEqual([
      { url: 'https://gate.joingonka.ai/v1/responses', model: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
    ]);
    const toml = readFileSync(join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model = "deepseek-ai/DeepSeek-V4-Flash-0731"');
  });

  it('claude-code keeps /v1/messages and everything else /v1/chat/completions', async () => {
    const expected: Record<string, string> = {
      'claude-code': 'https://gate.joingonka.ai/v1/messages',
      hermes: 'https://gate.joingonka.ai/v1/chat/completions',
      cline: 'https://gate.joingonka.ai/v1/chat/completions',
    };
    for (const [tool, url] of Object.entries(expected)) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
      vi.stubGlobal('fetch', fetchMock);

      await run({ tool }, deps());

      expect(probes(fetchMock).map((p) => p.url), tool).toEqual([url]);
    }
  });
});
