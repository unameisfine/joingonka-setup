/**
 * Адаптер ZCode (Z.ai) — instructions-only.
 *
 * ZCode официально поддерживает BYOK («any service compatible with OpenAI or
 * Anthropic protocols»), но провайдеры хранятся в СОБСТВЕННОМ хранилище
 * настроек (env-переменные вроде ANTHROPIC_BASE_URL он НЕ читает), файла
 * для безопасного редактирования нет → печатаем значения для UI.
 *
 * Шаги сверены с нашим live-гайдом /en/knowledge/zcode (актуализирован по
 * практическому тесту, PT-JOI-002): Settings → Model Settings → Add Provider,
 * API format «Chat completions», Add Model с Model ID и Context window.
 * В старых версиях вместо этого два поля: OpenAI Base URL (С /v1) и
 * Anthropic Base URL (домен БЕЗ пути — клиент сам дописывает /v1/messages).
 */
import {
  BASE_URL,
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCLAW_CONTEXT_WINDOW,
} from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** ZCode не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // Context window для поля «Add Model» — из каталога пакета (пер-модельный,
  // напр. DeepSeek 380000), иначе общий сетевой 200000.
  const spec = OPENCLAW_MODELS.find((m) => m.id === input.model);
  const contextWindow = spec?.contextWindow ?? OPENCLAW_CONTEXT_WINDOW;

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
      `Then Add Model → Model ID: ${input.model}, Context window: ${contextWindow}.`,
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
