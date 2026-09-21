/**
 * Адаптер Zoo Code (https://www.zoocode.dev) — instructions-only.
 *
 * Zoo Code (расширение VS Code `ZooCodeOrganization.zoo-code`, есть в Open VSX) —
 * преемник Roo Code: разработку продолжила группа его контрибьюторов после того,
 * как команда Roo свернула активную работу. Настройка — в UI расширения, как у
 * Roo и Cline; рабочие значения живут в SecretStorage VS Code, безопасного
 * плоского файла для записи нет, поэтому адаптер возвращает значения для ручного
 * ввода.
 *
 * Первоисточники (сверено 21.09.2026):
 *   - https://github.com/Zoo-Code-Org/Zoo-Code (README; src/package.json v3.82.2;
 *     в Open VSX на дату сверки — 3.83.x)
 *   - https://docs.zoocode.dev/providers/openai-compatible (дока, ред. 06.07.2026)
 *   - подписи полей — webview-ui/src/i18n/locales/en/settings.json и
 *     webview-ui/src/components/settings/providers/OpenAICompatible.tsx
 *   - дефолты кастомной модели — packages/types/src/providers/openai.ts
 *
 * Значения — вариант «OpenAI Compatible»:
 *   API Provider: OpenAI Compatible
 *   Base URL:     BASE_URL_OPENAI (С /v1)
 *   API Key:      <jg-ключ>
 *   Model:        <точный id, как отдаёт /v1/models>
 *
 * ★ Блок Model Configuration печатаем ОБЯЗАТЕЛЬНО. Дефолты Zoo для кастомной
 *   модели (`openAiModelInfoSaneDefaults`) — контекст 128000, картинки включены,
 *   потолок выдачи −1 — не совпадают ни с одной моделью сети: с ними Zoo
 *   сжимает контекст раньше времени (у DeepSeek окно втрое больше) и может
 *   предложить модели изображение, которого она не примет.
 *
 * NB: у Zoo есть авто-импорт — настройка VS Code `zoo-code.autoImportSettingsPath`
 * + JSON-файл конфигурации (наследие `roo-cline.autoImportSettingsPath`). Он
 * требует положить jg-ключ в файл на диске и править settings.json редактора —
 * мы этого избегаем (instructions-only безопаснее). Zoo работает ТОЛЬКО с
 * нативным tool calling, XML-фолбэка нет (есть у наших MiniMax/DeepSeek/GLM).
 */
import { BASE_URL_OPENAI, OPENCLAW_CONTEXT_WINDOW, OPENCLAW_MODELS } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Zoo не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // Лимиты — из каталога пакета. Незнакомый id `вендор/модель` разбор моделей
  // пропускает с предупреждением; для него берём консервативные значения:
  // общий контекст сети и наименьший потолок выдачи по каталогу.
  const spec = OPENCLAW_MODELS.find((m) => m.id === input.model);
  const contextWindow = spec?.contextWindow ?? OPENCLAW_CONTEXT_WINDOW;
  const maxOutput = spec?.maxTokens ?? Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens));

  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'Zoo Code is configured in the VS Code extension UI (no file is written).',
      'Open the Zoo Code settings (gear icon) → API Provider, then enter:',
      '',
      '  API Provider: OpenAI Compatible',
      `  Base URL:     ${BASE_URL_OPENAI}`,
      `  API Key:      ${input.apiKey}`,
      `  Model:        ${input.model}`,
      '',
      ...(spec
        ? [
            'Then set the real limits of this model under Model Configuration',
            '(the defaults do not fit any Gonka model):',
          ]
        : [
            `${input.model} is not in this installer's catalog — conservative network defaults`,
            `for Model Configuration (real limits: GET ${BASE_URL_OPENAI}/models):`,
          ]),
      '',
      `  Context Window Size: ${contextWindow}`,
      `  Max Output Tokens:   ${maxOutput}`,
      '  Image Support:       off',
      '',
      'Zoo Code relies on native tool calling only — all our Gonka models support it.',
    ],
  };
}

export const zooAdapter: Adapter = {
  id: 'zoo',
  label: 'Zoo Code (OpenAI Compatible, VS Code)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
