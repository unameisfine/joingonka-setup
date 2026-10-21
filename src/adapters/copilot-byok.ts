/**
 * Адаптер GitHub Copilot BYOK — instructions-only, три клиента.
 *
 * BYOK (bring your own key) у Copilot — «локальный»: ключ и модель задаются в
 * каждом клиенте отдельно и обрабатываются только на стороне клиента. Печатаем
 * три раздела: VS Code, Copilot CLI, JetBrains.
 *
 * Первоисточники (сверено 21.09.2026):
 *   VS Code   — https://code.visualstudio.com/docs/agent-customization/language-models
 *               (сюда редиректит прежний /docs/copilot/customization/language-models);
 *               https://code.visualstudio.com/blogs/2026/06/18/byok-vscode;
 *               исходники microsoft/vscode: extensions/copilot/package.json
 *               (провайдер `customendpoint`), src/vs/workbench/contrib/chat/common/
 *               languageModels.ts, src/vs/platform/userDataProfile/common/userDataProfile.ts
 *   CLI       — https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models
 *   JetBrains — https://github.blog/changelog/2026-07-14-github-copilot-for-jetbrains-expands-byok-capabilities/
 *               и https://github.blog/changelog/2025-09-11-bring-your-own-key-byok-support-for-jetbrains-ides-and-xcode-in-public-preview/
 *               (на него как на инструкцию ссылается docs.github.com →
 *               copilot/concepts/models/bring-your-own-key)
 *
 * ── VS Code ────────────────────────────────────────────────────────────────
 * Провайдер «OpenAI Compatible» и настройка `github.copilot.chat.customOAIModels`
 * объявлены deprecated; актуальный путь — провайдер Custom Endpoint
 * (`vendor: "customendpoint"`), конфигурация в `chatLanguageModels.json`. BYOK
 * работает без аккаунта GitHub и без плана Copilot (чат и агенты; inline
 * suggestions и семантический поиск по-прежнему требуют аккаунта).
 *
 * ★ Почему файл НЕ пишем, хотя схема документирована:
 *   1. Ключ. В схеме `customendpoint` свойство `apiKey` помечено `secret: true`.
 *      Ядро VS Code хранит в файле не ключ, а ссылку `${input:chat.lm.secret.<hash>}`
 *      на secret storage, а при чтении трактует ЛЮБОЕ значение как такую ссылку
 *      (`decodeSecretKey` → `secretStorage.get`). Литерал `jg-…` в файле
 *      разрешается в undefined → запросы уходят без авторизации (401). Наш канон
 *      «ключ литералом в нативный конфиг» здесь невыполним — ключ вводится в UI.
 *   2. Путь. Дока говорит только «VS Code opens a chatLanguageModels.json file»;
 *      расположение на диске не документировано. По исходникам это каталог
 *      ПРОФИЛЯ (`<user-data>/User/…`, у неосновного профиля — `User/profiles/<id>/…`),
 *      разный у Code / Insiders / VSCodium и portable-режима. При Remote-WSL, SSH
 *      и dev-контейнерах он лежит на КЛИЕНТСКОЙ машине: запись из WSL ушла бы в
 *      каталог, который VS Code не читает, а установщик отрапортовал бы успех.
 *   3. Стабильность. За год сменились три механизма (customOAIModels → провайдер
 *      `customoai` → `customendpoint`); дока и схема в package.json расходятся
 *      (provider-level `url`, `authorization` в `requestHeaders`).
 * UI-поток сам открывает файл пользователю, поэтому печатаем готовый блок
 * `"models"` с реальными лимитами — вставка занимает секунды и ничего не ломает.
 *
 * В запись модели сознательно НЕ добавляем `thinking` / `supportsReasoningEffort`:
 * поля необязательные, а их поведение со шлюзом живьём не проверялось.
 *
 * ── Copilot CLI ────────────────────────────────────────────────────────────
 * Провайдер задаётся ТОЛЬКО переменными окружения (конфиг-файла нет). Печатаем
 * блок `export` с литеральными значениями, как у Aider; shell-профиль
 * пользователя не трогаем. Требования CLI к модели (tool calling + streaming,
 * контекст от 128k) выполняют все модели сети.
 *
 * ── JetBrains ──────────────────────────────────────────────────────────────
 * Путь «Manage Models → Add Models → Save» документирован; custom endpoints —
 * на всех тарифах с 14.07.2026. Точная подпись провайдера для custom endpoint в
 * первоисточниках НЕ приведена, поэтому в тексте её не цитируем.
 *
 * BYOK-вызовы тарифицируются у провайдера (у нас) и не расходуют квоту запросов
 * Copilot (блог VS Code 18.06.2026). Для Business/Enterprise локальный BYOK в IDE
 * может быть отключён политикой администратора.
 */
import { BASE_URL_OPENAI, OPENCLAW_CONTEXT_WINDOW, OPENCLAW_MODELS } from '../constants.js';
import type { OpenClawModelSpec } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/**
 * Полный URL эндпоинта для VS Code. Дока: «To avoid ambiguity, provide the full
 * endpoint URL including the API path».
 */
const VSCODE_CHAT_COMPLETIONS_URL = `${BASE_URL_OPENAI}/chat/completions`;

/** Имя группы провайдера в VS Code (подпись в пикере моделей). */
const VSCODE_GROUP_NAME = 'JoinGonka';

/** Лимиты модели для печати: контекст целиком (вход + выход) и потолок выдачи. */
interface ModelLimits {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  /** false — id вне каталога установщика, значения консервативные. */
  inCatalog: boolean;
}

function limitsOf(spec: OpenClawModelSpec): ModelLimits {
  return {
    id: spec.id,
    name: spec.name,
    contextWindow: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
    maxOutput: spec.maxTokens,
    inCatalog: true,
  };
}

/**
 * Лимиты выбранной модели. Незнакомый id `вендор/модель` разбор моделей
 * пропускает с предупреждением (сеть может получить модель раньше установщика) —
 * для него берём консервативные значения: наименьшие по каталогу окно
 * (запасное OPENCLAW_CONTEXT_WINDOW) и потолок выдачи.
 */
function limitsFor(modelId: string): ModelLimits {
  const spec = OPENCLAW_MODELS.find((m) => m.id === modelId);
  if (spec) {
    return limitsOf(spec);
  }
  return {
    id: modelId,
    name: modelId,
    contextWindow: OPENCLAW_CONTEXT_WINDOW,
    maxOutput: Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens)),
    inCatalog: false,
  };
}

/**
 * Сколько токенов остаётся на вход. И VS Code (`maxInputTokens`), и Copilot CLI
 * (`COPILOT_PROVIDER_MAX_PROMPT_TOKENS`) ждут именно вход, а не всё окно; дока
 * VS Code требует, чтобы вход + выход не превышали контекст модели.
 */
function maxInput(limits: ModelLimits): number {
  return limits.contextWindow - limits.maxOutput;
}

/**
 * Запись модели для `chatLanguageModels.json`. Обязательные поля схемы
 * `customendpoint`: id, name, url, toolCalling, vision, maxOutputTokens
 * (+ maxInputTokens либо contextWindow). Порядок ключей — как в примерах доки.
 */
function vscodeModelEntry(limits: ModelLimits): Record<string, unknown> {
  return {
    id: limits.id,
    name: limits.name,
    url: VSCODE_CHAT_COMPLETIONS_URL,
    // Без toolCalling модель не показывается в пикере агентного режима.
    toolCalling: true,
    // Картинок на вход у моделей сети нет.
    vision: false,
    maxInputTokens: maxInput(limits),
    maxOutputTokens: limits.maxOutput,
  };
}

/**
 * Строки фрагмента `"models": [ … ]` для вставки в группу провайдера: выбранная
 * модель первой, следом остальной каталог сети. Печатаем именно фрагмент, а не
 * группу целиком: `apiKey` группы — ссылка на secret storage, её создаёт VS Code.
 */
function vscodeModelsBlock(selected: ModelLimits): string[] {
  const others = OPENCLAW_MODELS.filter((m) => m.id !== selected.id).map(limitsOf);
  const models = [selected, ...others].map(vscodeModelEntry);
  // Снимаем внешние фигурные скобки сериализации — остаётся свойство с отступом.
  return JSON.stringify({ models }, null, 2).split('\n').slice(1, -1);
}

/** Copilot BYOK не пишет файл — путь всегда null. */
function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const limits = limitsFor(input.model);
  const catalog = OPENCLAW_MODELS.map((m) => m.id).join(', ');
  const limitsText =
    `context window ${limits.contextWindow} tokens, max output ${limits.maxOutput} tokens`;
  const limitsLines = limits.inCatalog
    ? [`Limits of ${limits.id}: ${limitsText}.`]
    : [
        `${limits.id} is not in this installer's catalog — conservative network defaults`,
        `are used: ${limitsText} (real limits: GET ${BASE_URL_OPENAI}/models).`,
      ];

  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'GitHub Copilot BYOK is set up by hand in each client — no file is written for you',
      '(every client stores the key itself). Follow the section for the client you use.',
      ...limitsLines,
      'BYOK usage is billed by the gateway and does not count against Copilot request quotas.',
      '',
      '[1/3] VS Code — Custom Endpoint (works without a GitHub account or a Copilot plan)',
      '  1. Command Palette → "Chat: Manage Language Models" → Add Models → Custom Endpoint.',
      `  2. Group name and display name: ${VSCODE_GROUP_NAME}`,
      `  3. API key: ${input.apiKey}   (kept in VS Code secret storage, not in the file)`,
      '  4. API type: Chat Completions',
      '  5. VS Code opens chatLanguageModels.json — replace the "models" array of the new',
      `     ${VSCODE_GROUP_NAME} group with this one and save:`,
      '',
      ...vscodeModelsBlock(limits),
      '',
      `  6. Pick ${limits.id} in the chat model picker`,
      '     (restart VS Code if it does not show up).',
      'BYOK covers chat and agents; inline suggestions and semantic search still need a GitHub',
      'account. Signed out of GitHub? Also point chat.utilityModel and chat.utilitySmallModel',
      'at this model (chat titles, commit messages).',
      'The "OpenAI Compatible" provider and github.copilot.chat.customOAIModels are deprecated.',
      '',
      '[2/3] Copilot CLI (npm @github/copilot) — environment variables only',
      'Run these in the shell where you start Copilot CLI:',
      '',
      `  export COPILOT_PROVIDER_BASE_URL=${BASE_URL_OPENAI}`,
      '  export COPILOT_PROVIDER_TYPE=openai',
      `  export COPILOT_PROVIDER_API_KEY=${input.apiKey}`,
      `  export COPILOT_MODEL=${limits.id}`,
      `  export COPILOT_PROVIDER_MAX_PROMPT_TOKENS=${maxInput(limits)}`,
      `  export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=${limits.maxOutput}`,
      '  copilot',
      '',
      'They last for the current shell session: the installer never edits your shell profile.',
      'COPILOT_PROVIDER_* names are Copilot-specific, so your other tools are not affected.',
      'PowerShell: $env:NAME = "value" with the same names. More examples: copilot help providers',
      '',
      '[3/3] JetBrains IDEs — GitHub Copilot plugin',
      'Custom endpoints are available on all Copilot tiers since the 2026-07-14 plugin update.',
      'Open Copilot Chat → model picker → Manage Models, choose the OpenAI-compatible custom',
      'endpoint provider, click Add Models and enter:',
      '',
      `  Base URL: ${BASE_URL_OPENAI}`,
      `  API key:  ${input.apiKey}`,
      `  Model ID: ${limits.id}`,
      '',
      'Click Save, then select the model under your key and save again — it appears in the',
      'model picker.',
      '',
      'Copilot Business / Enterprise: local BYOK is governed by an administrator policy,',
      '"Bring Your Own Language Model Key". If the option is missing, ask your administrator',
      '(Copilot policy settings on GitHub.com).',
      `Network models: ${catalog}`,
      `(live list: GET ${BASE_URL_OPENAI}/models).`,
    ],
  };
}

export const copilotByokAdapter: Adapter = {
  id: 'copilot-byok',
  label: 'GitHub Copilot BYOK (VS Code / Copilot CLI / JetBrains)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
