/**
 * Адаптер Cline — instructions-only.
 *
 * Cline настраивается через UI расширения VS Code (панель API Configuration),
 * а не через файл конфигурации на диске, который мы могли бы безопасно
 * редактировать. Поэтому адаптер ничего не пишет: resolvePath()→null,
 * apply() возвращает wrote:false и готовые значения для ручного ввода.
 *
 * Значения — для варианта «OpenAI Compatible» (рекомендуемый в knowledge):
 *   API Provider: OpenAI Compatible
 *   Base URL:     BASE_URL_OPENAI (С /v1)
 *   API Key:      <jg-ключ>
 *   Model ID:     <модель>
 */
import { BASE_URL_OPENAI } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Cline не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'Cline is configured in the VS Code extension UI (no file is written).',
      'Open the Cline panel → Settings (gear) → API Configuration and set:',
      '  API Provider: OpenAI Compatible',
      `  Base URL:     ${BASE_URL_OPENAI}`,
      `  API Key:      ${input.apiKey}`,
      `  Model ID:     ${input.model}`,
      'Then click "Test connection" — it should pass in 1-3 seconds.',
    ],
  };
}

export const clineAdapter: Adapter = {
  id: 'cline',
  label: 'Cline (VS Code, OpenAI-compatible)',
  format: 'instructions',
  resolvePath,
  apply,
};
