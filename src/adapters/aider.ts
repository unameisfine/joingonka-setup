/**
 * Адаптер Aider (https://aider.chat) — instructions-only (env-based).
 *
 * Aider читает OpenAI-совместимый endpoint из env-переменных
 * (OPENAI_API_BASE / OPENAI_API_KEY) и принимает модель флагом --model.
 * Конфиг-файлы (.env / .aider.conf.yml) тоже работают, но самый чистый и
 * безопасный путь — env-переменные: ключ не оседает в файле на диске.
 *
 * Поэтому адаптер ничего не пишет, а возвращает готовые команды:
 *   export OPENAI_API_BASE=https://gate.joingonka.ai/v1
 *   export OPENAI_API_KEY=jg-...
 *   aider --model openai/moonshotai/Kimi-K2.6
 *
 * ⚠️ Имя модели — С префиксом `openai/` (litellm-маршрутизация на OpenAI-
 *   совместимого провайдера; без него Aider не поймёт endpoint).
 */
import { BASE_URL_OPENAI, AIDER_MODEL_PREFIX } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Aider не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const model = `${AIDER_MODEL_PREFIX}${input.model}`;
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'Aider is configured via environment variables (no file is written).',
      'Run these in your shell, then start Aider:',
      '',
      `  export OPENAI_API_BASE=${BASE_URL_OPENAI}`,
      `  export OPENAI_API_KEY=${input.apiKey}`,
      `  aider --model ${model}`,
      '',
      'The model name MUST keep the "openai/" prefix (litellm routing).',
      'To persist, add the two export lines to your ~/.bashrc or ~/.zshrc.',
    ],
  };
}

export const aiderAdapter: Adapter = {
  id: 'aider',
  label: 'Aider (OpenAI-compatible, env vars)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
