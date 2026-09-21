/**
 * Адаптер Cursor — instructions-only.
 *
 * Cursor настраивается через UI (Settings → Models): ключ и Base URL лежат
 * во внутреннем хранилище IDE, файла конфигурации, который можно безопасно
 * редактировать, нет. Адаптер ничего не пишет: resolvePath()→null,
 * apply() возвращает wrote:false и готовые значения для ручного ввода.
 *
 * ★ Сверено 21.09.2026 по первоисточникам:
 *   - https://cursor.com/docs/settings/api-keys (ведёт на
 *     cursor.com/help/models-and-usage/api-keys): «Open Cursor Settings > Models»;
 *     «Custom API keys only work with chat models. Tab completion continues using
 *     Cursor's built-in models.» Требования платного тарифа на странице НЕТ — про
 *     тарифы сказано лишь, как BYOK считается в лимитах. Поэтому строка «BYOK
 *     requires a Cursor Pro plan», стоявшая здесь до 0.4.5, убрана: мы утверждали
 *     о чужом продукте то, чего он сам не говорит.
 *   - поля «OpenAI API Key», «Override OpenAI Base URL» и добавление модели в
 *     Custom Models официальная страница не описывает; их подтверждают ответы
 *     сотрудника Cursor на официальном форуме:
 *     forum.cursor.com/t/override-openai-base-url-not-working/168323 (15.08.2026) —
 *     порядок настройки и «works for custom models used for chat and agent»;
 *     forum.cursor.com/t/cursor-managed-models-are-routed-through-override-openai-
 *     base-url/169088 (21.08.2026) — пока Override включён, ВСЕ запросы семейства
 *     OpenAI идут на свой endpoint, в том числе встроенные модели Cursor; обход —
 *     выключать Override. Без этой подсказки человек решит, что сломался Cursor.
 */
import { BASE_URL_OPENAI, formatModelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Cursor не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'Cursor is configured in its settings UI (no file is written).',
      'Open Cursor Settings → Models and set:',
      `  OpenAI API Key:           ${input.apiKey}`,
      `  Override OpenAI Base URL: ${BASE_URL_OPENAI}   (enable the override)`,
      `  Add custom model:         ${input.model}`,
      'Select the added model in the model picker, then verify with any prompt (Ctrl+L).',
      formatModelLimits(input.model),
      'Custom API keys only work with chat models — Cursor Tab autocomplete stays on',
      "Cursor's built-in models (a Cursor limitation).",
      "While the override is on, Cursor's own OpenAI-family models are sent to this",
      'endpoint too — switch the override off whenever you want to use them.',
    ],
  };
}

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor (IDE UI, OpenAI-compatible)',
  format: 'instructions',
  resolvePath,
  apply,
};
