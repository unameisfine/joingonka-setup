/**
 * Адаптер Continue.dev (https://continue.dev) — instructions-only (YAML-блок).
 *
 * Continue (VS Code + JetBrains + CLI) читает `~/.continue/config.yaml`
 * (`config.json` deprecated). Безопасный merge YAML требует знания чужой схемы
 * целиком, поэтому адаптер выдаёт готовый блок для вставки — без записи файла
 * (ключ вставляет пользователь).
 *
 * ★ Сверено 21.09.2026 по первоисточникам:
 *   - статус проекта — https://continue.dev («Continue has joined Cursor …
 *     Continue was acquired by Cursor») и README github.com/continuedev/continue
 *     («no longer actively maintained and is read-only», «Final 2.0.0 Release»;
 *     последние релизы v2.0.0/v2.1.0-vscode от 19.06.2026). Расширение работает,
 *     но не развивается — говорим об этом в первой же строке;
 *   - формат — https://docs.continue.dev/reference (исходник docs/reference.mdx):
 *     `name`, `version` и `schema` помечены **required**, `schema: v1`. До 0.4.5
 *     мы предлагали «создать файл, если его нет» и давали только элемент списка
 *     models — такой файл без шапки не проходит валидацию;
 *   - `defaultCompletionOptions.contextLength` / `maxTokens` — там же: окно и
 *     потолок ответа модели. Без них Continue берёт свои значения для
 *     незнакомого имени модели.
 *
 * `provider: openai` + `apiBase` (С /v1) превращает встроенного openai-провайдера
 * в клиент любого OpenAI-совместимого endpoint. `roles` заменили
 * experimental.modelRoles. `capabilities: [tool_use]` обязателен — см. сообщение
 * в конце блока и тикет #9 (24.08.2026).
 */
import { BASE_URL_OPENAI, modelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const { contextWindow, maxOutput } = modelLimits(input.model);
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'NOTE: Continue was acquired by Cursor. Its repository is read-only and is',
      'no longer actively maintained (2.0.0 was the final release); it still works as set up below.',
      '',
      'Continue.dev uses ~/.continue/config.yaml (YAML is the current format).',
      'No such file yet? Create it with this content — name, version and schema are required:',
      '',
      '  name: My Config',
      '  version: 1.0.0',
      '  schema: v1',
      '  models:',
      '    - name: Gonka',
      '      provider: openai',
      `      model: ${input.model}`,
      `      apiBase: ${BASE_URL_OPENAI}`,
      `      apiKey: ${input.apiKey}`,
      '      roles: [chat, edit, apply]',
      '      capabilities: [tool_use]',
      '      defaultCompletionOptions:',
      `        contextLength: ${contextWindow}`,
      `        maxTokens: ${maxOutput}`,
      '',
      'Already have a config.yaml? Add only the "- name: Gonka" entry to its `models:` list.',
      'Use a concrete model id (not AUTODETECT — it breaks the Continue CLI).',
      '`capabilities: [tool_use]` is required for Agent mode: Continue enables tools',
      'only for models it recognises (gpt-*, o*, codex*), so Gonka models get none',
      'without it — the agent cannot read files and chat stays blind to the project.',
    ],
  };
}

export const continueAdapter: Adapter = {
  id: 'continue',
  label: 'Continue.dev (OpenAI-compatible, VS Code/JetBrains)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
