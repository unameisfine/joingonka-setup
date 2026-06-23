/**
 * Адаптер Continue.dev (https://continue.dev) — instructions-only (YAML-блок).
 *
 * Continue (VS Code + JetBrains) читает `~/.continue/config.yaml` (новый канон;
 * `config.json` deprecated). Безопасный merge YAML требует парсера, поэтому
 * адаптер выдаёт готовый YAML-блок для вставки в `models:` — без записи файла
 * и без секрета на диске (ключ вставляет пользователь).
 *
 * Формат провайдера (research 2026): `provider: openai` + `apiBase` (С /v1)
 * превращает встроенного openai-провайдера в клиент любого OpenAI-совместимого
 * endpoint. `roles` (новое в YAML) заменили experimental.modelRoles.
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
      'Continue.dev uses ~/.continue/config.yaml (YAML is the current format).',
      'Add this under the top-level `models:` list (create the file if missing):',
      '',
      '  - name: Gonka',
      '    provider: openai',
      `    model: ${input.model}`,
      `    apiBase: ${BASE_URL_OPENAI}`,
      `    apiKey: ${input.apiKey}`,
      '    roles: [chat, edit, apply]',
      '',
      'Use a concrete model id (not AUTODETECT — it breaks the Continue CLI).',
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
