/**
 * Адаптер ZCode (Z.ai) — instructions-only.
 *
 * ZCode официально поддерживает BYOK («any model service compatible with the
 * Anthropic / OpenAI protocols»), но провайдеры хранятся в СОБСТВЕННОМ
 * хранилище настроек (env-переменные вроде ANTHROPIC_BASE_URL он НЕ читает) →
 * печатаем значения для UI.
 *
 * ★ Сверено 21.09.2026 по доке https://zcode.z.ai/en/docs/configuration
 * («Connect Models»):
 *   - «Custom Providers»: Model Settings → Add Provider внизу списка провайдеров →
 *     имя, Base URL, API Key → Add Model с id модели → «Turn on the enable switch
 *     to start using it». Последний шаг до 0.4.5 в инструкции отсутствовал:
 *     сохранённый провайдер выключен, и модель не появляется в селекторе;
 *   - «Per-Model Advanced Settings» и «Context Window»: у модели есть панель
 *     Advanced — «Max output tokens» и окно контекста; у моделей кастомного
 *     провайдера окно редактируемое, новое значение действует с новой сессии.
 * НЕ подтверждено докой (оставлено как было, из практического теста нашего
 * гайда /en/knowledge/zcode, PT-JOI-002): поле «API format: Chat completions» и
 * вид формы в старых версиях (два поля — OpenAI Base URL С /v1 и Anthropic Base
 * URL БЕЗ пути: клиент сам дописывает /v1/messages). В доке форма описана
 * словами «Set the OpenAI endpoint / Set the Anthropic endpoint».
 */
import { BASE_URL, BASE_URL_OPENAI, modelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** ZCode не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // Лимиты — из каталога пакета (пер-модельные: DeepSeek 380000/32768).
  const { contextWindow, maxOutput } = modelLimits(input.model);

  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'ZCode is configured in its settings UI (no file is written).',
      'Open ZCode → Settings → Model Settings → Add Provider and set:',
      '  Name:        JoinGonka',
      `  Base URL:    ${BASE_URL_OPENAI}`,
      `  API Key:     ${input.apiKey}`,
      '  API format:  Chat completions (/chat/completions)',
      `Then Add Model → Model ID: ${input.model}, and turn ON the provider's enable switch`,
      '(a saved provider stays off until you do).',
      'Open the model → Advanced and enter its real limits:',
      `  Context window: ${contextWindow}`,
      `  Max output tokens: ${maxOutput}`,
      'Older ZCode versions show two fields instead:',
      `  OpenAI Base URL:    ${BASE_URL_OPENAI}`,
      `  Anthropic Base URL: ${BASE_URL}   (no path — the client appends it)`,
      'Verify by asking the agent anything; 401 → check the key, 402 → balance.',
    ],
  };
}

export const zcodeAdapter: Adapter = {
  id: 'zcode',
  label: 'ZCode (Z.ai IDE UI, OpenAI-compatible)',
  format: 'instructions',
  resolvePath,
  apply,
};
