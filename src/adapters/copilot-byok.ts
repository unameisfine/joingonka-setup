/**
 * Адаптер GitHub Copilot BYOK — instructions-only.
 *
 * BYOK (bring your own key) — официальный механизм Copilot: с января 2026
 * поддерживается любой OpenAI-совместимый endpoint (public preview, планы
 * Pro и выше). Настраивается в UI (VS Code: Settings → Model Providers через
 * Copilot Chat; в Copilot для JetBrains — настройки плагина, с 14.07.2026);
 * ключ сохраняется в локальный keychain → файла для записи нет, печатаем
 * значения для UI.
 *
 * BYOK-вызовы тарифицируются у провайдера (у нас) и НЕ тратят premium-квоту
 * Copilot. Inline suggestions могут оставаться на моделях Copilot —
 * ограничение Copilot, не гейта (гайд /en/knowledge/copilot-byok).
 */
import { BASE_URL_OPENAI, OPENCLAW_MODELS } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Copilot BYOK не пишет файл — путь всегда null. */
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
      'GitHub Copilot BYOK is configured in the UI (no file is written).',
      'Requires a Copilot Pro plan or higher (BYOK is in public preview).',
      'Open Settings → Model Providers (VS Code: via Copilot Chat) and add:',
      '  Provider type: OpenAI compatible',
      `  Endpoint:      ${BASE_URL_OPENAI}`,
      `  API Key:       ${input.apiKey}   (stored in the local keychain)`,
      `Pick ${input.model} in the model switcher for your session.`,
      `Network models: ${catalog} (live list: GET ${BASE_URL_OPENAI}/models).`,
      'BYOK calls bill at gateway rates and do NOT consume the premium quota;',
      'inline suggestions may stay on Copilot models (a Copilot limitation).',
    ],
  };
}

export const copilotByokAdapter: Adapter = {
  id: 'copilot-byok',
  label: 'GitHub Copilot BYOK (VS Code/JetBrains UI)',
  format: 'instructions',
  resolvePath,
  apply,
};
