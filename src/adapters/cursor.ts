/**
 * Адаптер Cursor — instructions-only.
 *
 * Cursor настраивается через UI (Settings → Models): ключ и Base URL лежат
 * во внутреннем хранилище IDE, файла конфигурации, который можно безопасно
 * редактировать, нет. Адаптер ничего не пишет: resolvePath()→null,
 * apply() возвращает wrote:false и готовые значения для ручного ввода.
 *
 * ВАЖНО: BYOK (свой ключ) в Cursor требует план Pro и выше — на бесплатном
 * плане переопределение ключа не поддерживается. Cursor Tab-автокомплит
 * остаётся на собственных моделях Cursor (ограничение Cursor, не гейта).
 *
 * Шаги сверены с нашим live-гайдом /en/knowledge/cursor (актуализирован по
 * практическому тесту, PT-JOI-002).
 */
import { BASE_URL_OPENAI } from '../constants.js';
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
      'NOTE: using your own key (BYOK) requires a Cursor Pro plan or higher.',
      'Open Settings → Models and set:',
      `  OpenAI API Key:           ${input.apiKey}`,
      `  Override OpenAI Base URL: ${BASE_URL_OPENAI}   (enable the override)`,
      `  Add model:                ${input.model}`,
      'Select the added model for Chat/Composer, then verify with any prompt (Ctrl+L).',
      "Cursor Tab autocomplete stays on Cursor's own models (a Cursor limitation).",
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
