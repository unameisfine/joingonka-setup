/**
 * Адаптер Cline — instructions-only.
 *
 * Cline (VS Code) настраивается через UI расширения (Settings по иконке-шестерёнке),
 * а не через файл конфигурации на диске, который мы могли бы безопасно
 * редактировать (ключи лежат в VS Code SecretStorage / OS keychain). Поэтому
 * адаптер ничего не пишет: resolvePath()→null, apply() возвращает wrote:false
 * и готовые значения для ручного ввода.
 *
 * ★ Подписи полей сверены 21.09.2026 по двум первоисточникам:
 *   - дока https://docs.cline.bot/provider-config/openai-compatible — API Provider
 *     «OpenAI Compatible», Base URL, API Key, Model ID и раздел Model Configuration
 *     (Max Output Tokens, Context Window size, Image Support, цены);
 *   - исходник формы — github.com/cline/cline, apps/vscode/webview-ui/src/
 *     components/settings/providers/OpenAICompatible.tsx: «Base URL», «Model ID»,
 *     сворачиваемый блок «Model Configuration» с «Supports Images», «Context
 *     Window Size», «Max Output Tokens».
 * Кнопки «Verify» в форме НЕТ (в исходнике её нет вовсе; в доке слово встречается
 * только в устаревшем примере про v0). До 0.4.5 инструкция заканчивалась шагом
 * «click Verify» — человек искал несуществующую кнопку. Проверку связи делает сам
 * установщик (core/verify), а вместо кнопки печатаем то, что действительно нужно
 * ввести руками: лимиты модели. Дефолты Cline для кастомной модели
 * (apps/vscode/src/shared/api.ts, openAiModelInfoSafeDefaults: окно 128000,
 * картинки включены, потолок ответа не задан) не совпадают ни с одной моделью сети.
 *
 * NB (2026): у Cline появился отдельный CLI с конфигом
 * `~/.cline/data/settings/providers.json` и командой `cline auth` — но это CLI,
 * не VS Code-расширение, и доки рекомендуют `cline auth`, а не запись файла.
 * Потенциальная отдельная цель (вне scope этого instructions-only адаптера).
 */
import { BASE_URL_OPENAI, modelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Cline не пишет файл — путь всегда null. */
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
      'Cline is configured in the VS Code extension UI (no file is written).',
      'Open the Cline panel → Settings (gear icon) and set:',
      '  API Provider: OpenAI Compatible',
      `  Base URL:     ${BASE_URL_OPENAI}`,
      `  API Key:      ${input.apiKey}`,
      `  Model ID:     ${input.model}`,
      'Then expand "Model Configuration" and enter the real limits of this model',
      "(Cline's defaults for a custom model do not match it):",
      `  Context Window Size: ${contextWindow}`,
      `  Max Output Tokens:   ${maxOutput}`,
      '  Supports Images:     off   (Gonka models take text only)',
    ],
  };
}

export const clineAdapter: Adapter = {
  id: 'cline',
  label: 'Cline (VS Code, OpenAI-compatible)',
  format: 'instructions',
  resolvePath,
  apply,
};
