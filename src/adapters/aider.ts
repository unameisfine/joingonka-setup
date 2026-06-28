/**
 * Адаптер Aider (https://aider.chat) — instructions-only.
 *
 * Aider берёт OpenAI-совместимый endpoint+ключ из конфиг-файла `.aider.conf.yml`
 * (поля openai-api-base / openai-api-key — имя именно _API_BASE, НЕ _BASE_URL) ИЛИ
 * из env, и принимает модель флагом --model.
 *
 * Адаптер ничего не пишет, а возвращает инструкции. ВЕДЁМ с нативного конфига
 * (без глобального env); env-вариант — лишь как разовая сессия:
 *   .aider.conf.yml: openai-api-base / openai-api-key / model
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
      'Aider takes the endpoint + key from a config file or env vars (nothing is written for you).',
      'Recommended — a .aider.conf.yml (no global env, your other tools untouched).',
      'Aider loads it from home / git-root / cwd:',
      '',
      `  openai-api-base: ${BASE_URL_OPENAI}`,
      `  openai-api-key: ${input.apiKey}`,
      `  model: ${model}`,
      '',
      'The model name MUST keep the "openai/" prefix (litellm routing).',
      '',
      'Or, just for a one-off session in the current shell (transient, not persisted):',
      `  export OPENAI_API_BASE=${BASE_URL_OPENAI}`,
      `  export OPENAI_API_KEY=${input.apiKey}`,
      `  aider --model ${model}`,
      'Avoid putting that export in ~/.bashrc — a global OPENAI_* would hijack your',
      'other OpenAI-compatible tools.',
    ],
  };
}

export const aiderAdapter: Adapter = {
  id: 'aider',
  label: 'Aider (OpenAI-compatible)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
