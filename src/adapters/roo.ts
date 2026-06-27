/**
 * Адаптер Roo Code (https://roocode.com) — instructions-only.
 *
 * Roo (VS Code, форк Cline) настраивается в UI расширения. Рабочие настройки
 * живут в зашифрованном SecretStorage VS Code — безопасного плоского файла для
 * записи нет, поэтому адаптер возвращает значения для ручного ввода (как Cline).
 *
 * Значения — вариант «OpenAI Compatible»:
 *   API Provider: OpenAI Compatible
 *   Base URL:     BASE_URL_OPENAI (С /v1)
 *   API Key:      <jg-ключ>
 *   Model:        <точный id, как отдаёт /v1/models>
 *
 * NB: у Roo есть авто-импорт через VS Code setting `roo-cline.autoImportSettingsPath`
 * + JSON-профиль, но он требует записать jg-ключ в файл на диск — мы этого избегаем
 * (instructions-only безопаснее). Roo требует НАТИВНЫЙ tool-calling у модели (есть
 * у наших Kimi/MiniMax).
 */
import { BASE_URL_OPENAI } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'Roo Code is configured in the VS Code extension UI (no file is written).',
      'Open the Roo settings (gear icon) → API Provider, then enter:',
      '',
      '  API Provider: OpenAI Compatible',
      `  Base URL:     ${BASE_URL_OPENAI}`,
      `  API Key:      ${input.apiKey}`,
      `  Model:        ${input.model}`,
      '',
      'Roo needs native tool-calling — our Kimi/MiniMax models support it.',
    ],
  };
}

export const rooAdapter: Adapter = {
  id: 'roo',
  label: 'Roo Code (OpenAI Compatible, VS Code)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
