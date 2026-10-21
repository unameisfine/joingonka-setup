/**
 * Адаптер JetBrains AI Assistant — instructions-only.
 *
 * AI Assistant (IntelliJ IDEA, PyCharm, WebStorm и др.) принимает
 * OpenAI-совместимые провайдеры через UI (Settings → Tools → AI Assistant →
 * Providers & API keys); ключ уходит в хранилище IDE, редактируемого файла
 * нет → печатаем значения для UI.
 *
 * ★ Сверено 21.09.2026 по официальной справке AI Assistant 2026.2:
 *   - https://www.jetbrains.com/help/ai-assistant/use-custom-models.html
 *     (ред. 28.07.2026): раздел «Third-party AI providers» — Provider, URL, API Key,
 *     переключатель «Tool calling» («whether the model supports calling tools
 *     configured through MCP»), Test Connection, Apply. Для OpenAI-совместимых
 *     endpoints модели назначаются вручную в «Models Assignment»: Core features,
 *     Instant helpers, Context window (дефолт 64 000 токенов — почти втрое меньше
 *     самого короткого окна сети, 180 000). Там же: «Next edit suggestions» и
 *     «Code completion» НЕ работают на моделях из этого раздела — им нужны
 *     FIM/edit-prediction модели, а чат-модели для этого «not suitable»;
 *   - https://www.jetbrains.com/help/ai-assistant/activate-agents.html
 *     (ред. 04.08.2026), таблица способов активации: Junie — JetBrains AI
 *     «Supported», API key (BYOK) «Not supported».
 * До 0.4.5 про Tool calling не было ни слова (без него модель не получает
 * MCP-инструменты), а окно контекста оставалось дефолтным.
 */
import { BASE_URL_OPENAI, OPENCLAW_MODELS, modelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** JetBrains не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const catalog = OPENCLAW_MODELS.map((m) => m.id).join(', ');
  const { contextWindow, maxOutput } = modelLimits(input.model);
  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'JetBrains AI Assistant is configured in the IDE UI (no file is written).',
      'Open Settings → Tools → AI Assistant → Providers & API keys.',
      'In "Third-party AI providers" set:',
      '  Provider:      OpenAI Compatible',
      `  URL:           ${BASE_URL_OPENAI}`,
      `  API Key:       ${input.apiKey}`,
      '  Tool calling:  enabled   (all Gonka models call tools natively; MCP needs it)',
      'Click "Test Connection", then "Apply".',
      `In "Models Assignment" pick ${input.model}`,
      'for Core features and Instant helpers, and set:',
      `  Context window: ${contextWindow}   (the IDE default is 64000; max output is ${maxOutput} tokens)`,
      `Network models: ${catalog} (live list: GET ${BASE_URL_OPENAI}/models).`,
      'What stays on JetBrains models: code completion and next edit suggestions (they',
      'need FIM / edit-prediction models, so leave "AI Completion" on JetBrains), and',
      'Junie — it works only with a JetBrains AI subscription, not with your own key.',
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
