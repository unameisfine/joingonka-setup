/**
 * Оркестратор установки.
 *
 * Склеивает шаги, не зная деталей конкретных инструментов:
 *   1. выбрать инструмент (явный --tool или интерактивный select);
 *   2. получить API-ключ (из env в non-interactive, иначе password-промпт);
 *   3. определить модель (default / шорткат minimax|deepseek|glm / явный id);
 *   3a. запросить живые цены, если адаптер пишет их в конфиг;
 *   4. вызвать adapter.apply().
 *
 * Промпты и запуск внешних программ инъектируются через deps — это делает
 * оркестратор полностью тестируемым (spy-функции, поддельный CLI OpenCode) и
 * отвязывает его от @inquirer/prompts и от того, что стоит на машине.
 */
import { API_KEY_ENV } from './constants.js';
import type { RunCommand } from './core/commands.js';
import { validateApiKey } from './core/validate.js';
import { canonicalModel } from './core/models.js';
import { getAdapter, localScopeToolIds, toolIds } from './adapters/registry.js';
import type { ApplyResult, Scope } from './adapters/types.js';
import { verifyConfig, type VerifyResult } from './core/verify.js';
import { fetchLivePricing } from './core/pricing.js';

/** Опции запуска (из CLI-аргументов). */
export interface RunOptions {
  /** Идентификатор инструмента; если не задан — спросим интерактивно. */
  tool?: string;
  /** 'user' (глобально) или 'local' (в проекте). По умолчанию 'user'. */
  scope?: Scope;
  /** Модель: undefined → default; 'glm'/'deepseek' → шорткаты; иначе явный id. */
  model?: string;
  /** Неинтерактивный режим: ключ берётся из env, промпты запрещены. */
  nonInteractive?: boolean;
  /** Live-проверка настройки после записи (реальный запрос к gate). По умолчанию true. */
  verify?: boolean;
}

/** Инъектируемые зависимости (в проде — core/prompt.ts и core/commands.ts). */
export interface RunDeps {
  askTool: () => Promise<string>;
  askApiKey: () => Promise<string>;
  /**
   * Запуск внешних программ — адаптер OpenCode так узнаёт версию и кладёт ключ в
   * хранилище OpenCode 2. Обязателен, чтобы cli.ts не мог его забыть: без него
   * OpenCode 2 молча остался бы без ключа.
   */
  runCommand: RunCommand;
}

/** Что вернул запуск — для вывода в CLI. */
export interface RunOutcome {
  toolId: string;
  result: ApplyResult;
  /** Результат live-проверки (undefined, если verify отключён через --no-verify). */
  verification?: VerifyResult;
  /** Непустое, если модель вне каталога установщика (записали, но предупреждаем). */
  modelWarning?: string;
}

export async function run(options: RunOptions, deps: RunDeps): Promise<RunOutcome> {
  const scope: Scope = options.scope ?? 'user';
  if (scope !== 'user' && scope !== 'local') {
    throw new Error(`Unknown scope: ${String(scope)}. Valid scopes: user, local.`);
  }

  // 1. Выбор инструмента: явный --tool либо интерактивный select.
  const toolId = options.tool ?? (await deps.askTool());
  const adapter = getAdapter(toolId);
  if (!adapter) {
    throw new Error(`Unknown tool: ${toolId}. Valid tools: ${toolIds().join(', ')}.`);
  }

  // 1a. Область установки. Инструмент без проектного конфига обязан сказать
  //     об этом ДО записи: молча положить конфиг в домашний каталог, когда
  //     человек просил проект, — тихий обман (так было до 0.4.5).
  if (scope === 'local' && !adapter.supportsLocalScope) {
    throw new Error(
      `${adapter.id} keeps a single per-user config, so --scope local does not apply to it. ` +
        `Re-run without --scope local (supported for: ${localScopeToolIds().join(', ')}).`,
    );
  }

  // 2. API-ключ. В non-interactive — ТОЛЬКО из env (никогда из CLI-аргумента:
  //    аргумент попал бы в историю shell/процессов — это утечка секрета).
  let apiKey: string;
  if (options.nonInteractive) {
    const fromEnv = process.env[API_KEY_ENV];
    if (!fromEnv) {
      throw new Error(
        `Non-interactive mode requires the ${API_KEY_ENV} environment variable (jg-...).`,
      );
    }
    const valid = validateApiKey(fromEnv);
    if (valid !== true) {
      throw new Error(`Invalid ${API_KEY_ENV}: ${valid}`);
    }
    apiKey = fromEnv;
  } else {
    apiKey = await deps.askApiKey();
  }

  // 3. Модель. Разбор ДО записи: выведенная из сети модель (kimi и т.п.) или
  //    опечатка в алиасе должны останавливать установку, а не портить конфиг.
  const modelExplicit = typeof options.model === 'string' && options.model.trim() !== '';
  const { model, warning: modelWarning } = canonicalModel(options.model, adapter.defaultModel);

  // 3a. Живые цены — один запрос и только для адаптера, который пишет `cost`
  //     в конфиг (OpenClaw, Pi). Цена справочная: недоступный шлюз даёт null, и
  //     адаптер молча берёт константу — установку это не останавливает.
  const pricing = adapter.wantsPricing ? await fetchLivePricing() : undefined;

  // 4. Применяем.
  const result = await adapter.apply({
    apiKey,
    model,
    scope,
    modelExplicit,
    pricing,
    runCommand: deps.runCommand,
  });

  // 5. Live-проверка: реальный запрос к gate записанными ключом+моделью —
  //    подтверждает, что настройка рабочая (ловит мёртвый ключ/URL/модель —
  //    тот класс молчаливого провала, что дал OpenClaw-баг). По умолчанию вкл.
  //    Видит ли ключ сам инструмент, шлюз не знает: это `result.toolCheck`
  //    (OpenCode 2), и «✓ Verified» решает report.ts по обоим.
  let verification: VerifyResult | undefined;
  if (options.verify !== false) {
    verification = await verifyConfig({
      apiMode: adapter.apiMode ?? 'openai',
      apiKey,
      model,
    });
  }

  return { toolId: adapter.id, result, verification, modelWarning };
}
