/**
 * Адаптер JetBrains AI Assistant — instructions-only.
 *
 * AI Assistant (IntelliJ IDEA, PyCharm, WebStorm и др., серия 2026.1+)
 * принимает OpenAI-совместимые провайдеры через UI (Settings → Tools →
 * AI Assistant → Providers & API keys); ключ уходит в хранилище IDE,
 * редактируемого файла нет → печатаем значения для UI.
 *
 * Ограничение (честно, из гайда /en/knowledge/jetbrains): кастомные
 * провайдеры на 2026.1 покрывают чат и генерацию, но НЕ Junie
 * (агент JetBrains) и не next-edit suggestions — те остаются на облаке
 * JetBrains. Это ограничение IDE, не гейта.
 */
import { BASE_URL_OPENAI, OPENCLAW_MODELS } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** JetBrains не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const catalog = OPENCLAW_MODELS.map((m) => m.id).join(', ');
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'JetBrains AI Assistant is configured in the IDE UI (no file is written).',
      'Open Settings → Tools → AI Assistant → Providers & API keys and set:',
      '  Provider:  OpenAI Compatible',
      `  Base URL:  ${BASE_URL_OPENAI}`,
      `  API key:   ${input.apiKey}`,
      'Click "Test Connection", then in Models Assignment assign a model',
      `(e.g. ${input.model}) to Core features and Instant helpers.`,
      `Network models: ${catalog} (live list: GET ${BASE_URL_OPENAI}/models).`,
      'Junie and next-edit suggestions stay on JetBrains cloud (IDE limitation).',
    ],
  };
}

export const jetbrainsAdapter: Adapter = {
  id: 'jetbrains',
  label: 'JetBrains AI Assistant (IDE UI, OpenAI-compatible)',
  format: 'instructions',
  resolvePath,
  apply,
};
