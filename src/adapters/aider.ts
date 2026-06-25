/**
 * Адаптер Aider (https://aider.chat) — instructions-only (env-based).
 *
 * Aider читает OpenAI-совместимый endpoint из env (OPENAI_API_BASE / OPENAI_API_KEY —
 * имя именно _API_BASE, НЕ _BASE_URL) и принимает модель флагом --model.
 *
 * Адаптер ничего не пишет, а возвращает готовые команды для разовой сессии:
 *   export OPENAI_API_BASE=https://gate.joingonka.ai/v1
 *   export OPENAI_API_KEY=jg-...
 *   aider --model openai/moonshotai/Kimi-K2.6
 *
 * ⚠️ Имя модели — С префиксом `openai/` (litellm-маршрутизация на OpenAI-
 *   совместимого провайдера; без него Aider не поймёт endpoint).
 *
 * ⚠️ ПЕРСИСТЕНТНОСТЬ: глобальный `export OPENAI_*` в ~/.bashrc/~/.zshrc
 *   перехватывает ВСЕ OpenAI-совместимые инструменты пользователя. Поэтому для
 *   постоянной настройки рекомендуем per-project `.aider.conf.yml` (поля
 *   openai-api-base/openai-api-key/model — endpoint+ключ+модель в одном файле,
 *   глобальный env не трогается). Aider грузит его из home/git-root/cwd.
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
      'Aider takes the endpoint + key from env vars or a config file (nothing is written for you).',
      'Quickest — set them for the current shell, then start Aider:',
      '',
      `  export OPENAI_API_BASE=${BASE_URL_OPENAI}`,
      `  export OPENAI_API_KEY=${input.apiKey}`,
      `  aider --model ${model}`,
      '',
      'The model name MUST keep the "openai/" prefix (litellm routing).',
      '',
      'To persist WITHOUT touching global env (recommended — a global export of',
      'OPENAI_* in ~/.bashrc would hijack your other OpenAI-compatible tools),',
      'put a .aider.conf.yml in your project root instead:',
      `  openai-api-base: ${BASE_URL_OPENAI}`,
      `  openai-api-key: ${input.apiKey}`,
      `  model: ${model}`,
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
