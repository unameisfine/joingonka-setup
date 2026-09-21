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
 *   aider --model openai/MiniMaxAI/MiniMax-M2.7
 *
 * ⚠️ Имя модели — С префиксом `openai/` (litellm-маршрутизация на OpenAI-
 *   совместимого провайдера; без него Aider не поймёт endpoint).
 *
 * ⚠️ ПЕРСИСТЕНТНОСТЬ: глобальный `export OPENAI_*` в ~/.bashrc/~/.zshrc
 *   перехватывает ВСЕ OpenAI-совместимые инструменты пользователя. Поэтому для
 *   постоянной настройки рекомендуем per-project `.aider.conf.yml` (поля
 *   openai-api-base/openai-api-key/model — endpoint+ключ+модель в одном файле,
 *   глобальный env не трогается). Aider грузит его из home/git-root/cwd.
 *
 * ★ Лимиты модели. Сверено 21.09.2026 по доке Aider
 *   https://aider.chat/docs/config/adv-model-settings.html: для незнакомой модели
 *   Aider печатает предупреждение «unknown context window size and costs» и берёт
 *   «sane defaults»; реальные значения регистрируются в `.aider.model.metadata.json`
 *   (home / корень git / cwd) — словарь по ПОЛНОМУ имени модели с префиксом
 *   провайдера, причём префикс обязан совпасть с полем `litellm_provider`.
 *   Aider лимиты не навязывает, только сообщает о них, поэтому блок необязательный.
 *   Env-имена OPENAI_API_BASE / OPENAI_API_KEY — https://aider.chat/docs/llms/openai-compat.html.
 */
import { BASE_URL_OPENAI, AIDER_MODEL_PREFIX, modelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Aider не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const model = `${AIDER_MODEL_PREFIX}${input.model}`;
  const { contextWindow, maxOutput } = modelLimits(input.model);
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
      'Optional — tell Aider the real limits of this model (otherwise it warns about an',
      'unknown model and assumes defaults). Put a .aider.model.metadata.json next to it:',
      '',
      `  { "${model}": { "max_input_tokens": ${contextWindow}, "max_output_tokens": ${maxOutput},`,
      `      "max_tokens": ${maxOutput}, "litellm_provider": "openai", "mode": "chat" } }`,
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
