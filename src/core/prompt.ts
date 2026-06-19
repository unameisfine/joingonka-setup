/**
 * Интерактивные промпты поверх @inquirer/prompts.
 *
 * Вынесены в отдельный модуль, чтобы оркестратор (run.ts) принимал их как
 * зависимости и тесты могли подменять промпты spy-функциями без реального
 * stdin. В проде CLI передаёт именно эти реализации.
 */
import { password, select } from '@inquirer/prompts';
import { validateApiKey } from './validate.js';
import { listTools } from '../adapters/registry.js';

/**
 * Запрос API-ключа через password-промпт (маскируется, не попадает
 * в историю stdin). Валидация — тот же validateApiKey, что и для env-ключа.
 */
export async function askApiKey(): Promise<string> {
  return password({
    message: 'Enter your JoinGonka API key (jg-...):',
    mask: '*',
    validate: validateApiKey,
  });
}

/** Выбор инструмента из меню (список берётся из реестра адаптеров). */
export async function askTool(): Promise<string> {
  return select({
    message: 'Which tool do you want to configure?',
    choices: listTools(),
  });
}
