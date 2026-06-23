/**
 * Оркестратор установки.
 *
 * Склеивает шаги, не зная деталей конкретных инструментов:
 *   1. выбрать инструмент (явный --tool или интерактивный select);
 *   2. получить API-ключ (из env в non-interactive, иначе password-промпт);
 *   3. определить модель (default / kimi / явный id);
 *   4. вызвать adapter.apply().
 *
 * Промпты инъектируются через deps — это делает оркестратор полностью
 * тестируемым (spy-функции) и отвязывает его от @inquirer/prompts.
 */
import { DEFAULT_MODEL, KIMI_MODEL } from './constants.js';
import { validateApiKey } from './core/validate.js';
import { getAdapter, listTools } from './adapters/registry.js';
import type { ApplyResult, Scope } from './adapters/types.js';
import { verifyConfig, type VerifyResult } from './core/verify.js';

/** Опции запуска (из CLI-аргументов). */
export interface RunOptions {
  /** Идентификатор инструмента; если не задан — спросим интерактивно. */
  tool?: string;
  /** 'user' (глобально) или 'local' (в проекте). По умолчанию 'user'. */
  scope?: Scope;
  /** Модель: undefined → default; 'kimi' → Kimi; иначе трактуется как явный id. */
  model?: string;
  /** Неинтерактивный режим: ключ берётся из env, промпты запрещены. */
  nonInteractive?: boolean;
  /** Live-проверка настройки после записи (реальный запрос к gate). По умолчанию true. */
  verify?: boolean;
}

/** Инъектируемые промпты (в проде — реализации из core/prompt.ts). */
export interface RunDeps {
  askTool: () => Promise<string>;
  askApiKey: () => Promise<string>;
}

/** Что вернул запуск — для вывода в CLI. */
export interface RunOutcome {
  toolId: string;
  result: ApplyResult;
  /** Результат live-проверки (undefined, если verify отключён через --no-verify). */
  verification?: VerifyResult;
}

/**
 * Разрешает значение модели:
 * - undefined / пусто → DEFAULT_MODEL;
 * - 'kimi' (регистронезависимо) → KIMI_MODEL;
 * - любое другое → используется как явный id модели.
 */
function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  if (model.toLowerCase() === 'kimi') return KIMI_MODEL;
  return model;
}

/** Имя env-переменной с ключом для non-interactive режима. */
const API_KEY_ENV = 'JOINGONKA_API_KEY';

export async function run(options: RunOptions, deps: RunDeps): Promise<RunOutcome> {
  const scope: Scope = options.scope ?? 'user';

  // 1. Выбор инструмента: явный --tool либо интерактивный select.
  const toolId = options.tool ?? (await deps.askTool());
  const adapter = getAdapter(toolId);
  if (!adapter) {
    const valid = listTools()
      .map((t) => t.value)
      .join(', ');
    throw new Error(`Unknown tool: ${toolId}. Valid tools: ${valid}.`);
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

  // 3. Модель.
  const model = resolveModel(options.model);

  // 4. Применяем.
  const result = await adapter.apply({ apiKey, model, scope });

  // 5. Live-проверка: реальный запрос к gate записанными ключом+моделью —
  //    подтверждает, что настройка рабочая (ловит мёртвый ключ/URL/модель —
  //    тот класс молчаливого провала, что дал OpenClaw-баг). По умолчанию вкл.
  let verification: VerifyResult | undefined;
  if (options.verify !== false) {
    verification = await verifyConfig({
      apiMode: adapter.apiMode ?? 'openai',
      apiKey,
      model,
    });
  }

  return { toolId: adapter.id, result, verification };
}
