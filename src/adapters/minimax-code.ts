/**
 * Адаптер MiniMax Code (CLI `mcode`, https://github.com/MiniMax-AI/minimax-code) —
 * YAML-конфиг ~/.minimax/config.yaml.
 *
 * Сторонний endpoint у mcode называется BYOK-провайдером и живёт в ветке
 * `custom_provider` (ветка `minimax_api` зарезервирована за официальным API):
 *   custom_provider.<key> = { name, kind, enabled, api,
 *                             options: { apiKey, baseURL, authMode },
 *                             models: { "<id>": { name, [reasoning], limit:{context,output} } } }
 *   defaultModel = "custom_provider:<key>/<modelId>"
 *
 * ★ Первоисточник (сверено 21.09.2026, mcode 0.5.1 = npm @minimax-ai/code@0.5.1,
 *   коммит ae65651d; продукт молодой — формат перепроверять при мажорных релизах):
 *   - README, раздел «Use your own API key (BYOK)»;
 *   - docs/examples.md («Choose your own model», «Third-party relays…») — пример
 *     ручной правки config.yaml, форматы API, права файла;
 *   - docs/installation.md («Accounts and data») — каталог данных и его env;
 *   - docs/tui-capabilities.md — ссылка `custom_provider:<id>/<model-id>`, id с `/`;
 *   - исходники: packages/config/src/config.ts (ModelConfig, ProviderOptions,
 *     CustomProviderConfig, getConfigPath), local-model-provider-write.ts (что и
 *     как пишет сам mcode, парные ключи дефолта), model-availability.ts (префикс
 *     `custom_provider:`), packages/local-runtime-v2/…/service-custom-provider-
 *     operations.ts (форма записи `provider add`), provider-key.ts (ключ из имени),
 *     connectivity/provider-request.ts (baseURL → /chat/completions).
 *
 * Что прописываем — ровно то, что пишет `mcode provider add --name JoinGonka
 * --api-format openai-completions … --use`, только без сетевой проверки:
 *   api     = "openai-completions" — ЯВНО: без поля mcode берёт anthropic-messages
 *             и пошёл бы на <baseURL>/v1/messages;
 *   baseURL = BASE_URL_OPENAI (С /v1 — mcode дописывает /chat/completions);
 *   apiKey  = ЛИТЕРАЛЬНЫЙ jg-... (файл 0o600). Сам mcode хранит ключ так же:
 *             `--api-key-env` читает переменную и кладёт в config.yaml ЗНАЧЕНИЕ,
 *             а не ссылку (docs/examples.md);
 *   limit   — реальные context/output: без них любая незнакомая модель получает
 *             200 000 / 16 384, то есть DeepSeek терял бы половину окна, а
 *             MiniMax и GLM просили бы вдвое больше выдачи, чем отдаёт сеть.
 *
 * Ключ провайдера `joingonka` — то, во что mcode сам превращает имя «JoinGonka»
 * (provider-key.ts: нижний регистр, kebab), поэтому провайдер, заведённый руками
 * под тем же именем, мы обновляем, а не дублируем.
 *
 * Парные ключи дефолта: defaultModelVariant / defaultModelThinking /
 * defaultModelContextWindow относятся к КОНКРЕТНОЙ модели. Меняя defaultModel,
 * снимаем их (так поступает и mcode — updateLocalByokConfig): иначе окно 512 000
 * от MiniMax-M3 применилось бы к нашей модели. Дефолт не меняется — не трогаем.
 *
 * ⚠ mcode переписывает config.yaml целиком при собственных сохранениях (js-yaml,
 * комментарии теряются уже на его стороне) и берёт на файл блокировку
 * proper-lockfile, которую мы без новой зависимости взять не можем. Поэтому в
 * сообщениях просим закрыть mcode на время установки.
 *
 * Путь один для обоих scope. Каталог данных: MINIMAX_DATA_DIR, затем
 * MAVIS_DATA_DIR (оба — непустые), иначе ~/.minimax. Именованный профиль mcode
 * (`--profile x` → ~/.minimax-x) публичной env-переменной не имеет — для него
 * установщик запускают с MINIMAX_DATA_DIR=~/.minimax-x.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Document } from 'yaml';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
  type OpenClawModelSpec,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { staleRefsNote } from '../core/stale-refs.js';
import { ensureMapAt, loadYamlMap, renderYaml } from '../core/yaml-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Ключ нашего провайдера в ветке `custom_provider` (= slug имени «JoinGonka»). */
const MCODE_PROVIDER_KEY = 'joingonka';

/** Отображаемое имя провайдера в /provider и `mcode provider list`. */
const MCODE_PROVIDER_NAME = 'JoinGonka';

/** Префикс id кастомного провайдера в ссылках на модель (model-availability.ts). */
const MCODE_PROVIDER_ID = `custom_provider:${MCODE_PROVIDER_KEY}`;

/** Формат API: /v1/chat/completions. Допустимы ещё openai-responses и anthropic-messages. */
const MCODE_API_FORMAT = 'openai-completions';

/** Ключи, привязанные к конкретной модели по умолчанию (local-model-provider-write.ts). */
const PAIRED_DEFAULT_KEYS = ['defaultModelVariant', 'defaultModelThinking', 'defaultModelContextWindow'];

/** Права на config.yaml — только владелец: внутри литеральный ключ (mcode требует того же). */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Каталог данных mcode (packages/config/src/config.ts, getExplicitPublicDataDirEnv):
 * непустой MINIMAX_DATA_DIR, затем непустой MAVIS_DATA_DIR, иначе ~/.minimax.
 * homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env).
 */
function dataDir(): string {
  const fromEnv = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
  return fromEnv ? fromEnv : join(homedir(), '.minimax');
}

function resolvePath(_scope: Scope): string {
  return join(dataDir(), 'config.yaml');
}

/**
 * Запись модели: только поля, которые mcode действительно читает (ModelConfig):
 * `name` — подпись в выборе модели, `reasoning` — уровень размышлений по
 * умолчанию (model-ref.ts, resolveThinkingLevel), `limit` — окно и потолок выдачи.
 */
function modelEntry(spec: OpenClawModelSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: spec.name };
  if (spec.reasoning) entry.reasoning = true;
  entry.limit = { context: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW, output: spec.maxTokens };
  return entry;
}

/** Правки ветки custom_provider: наш провайдер; каталог моделей — целиком заново. */
function editProvider(doc: Document, filePath: string, apiKey: string): void {
  ensureMapAt(doc, ['custom_provider'], filePath);
  // custom_provider.joingonka и его options — НАШИ ключи: мусор заменяем.
  const provider = ['custom_provider', MCODE_PROVIDER_KEY];
  ensureMapAt(doc, provider, filePath, true);
  ensureMapAt(doc, [...provider, 'options'], filePath, true);

  doc.setIn([...provider, 'name'], MCODE_PROVIDER_NAME);
  doc.setIn([...provider, 'kind'], 'custom');
  // Выключенный провайдер выпадает из списка моделей — установка его возвращает.
  doc.setIn([...provider, 'enabled'], true);
  doc.setIn([...provider, 'api'], MCODE_API_FORMAT);
  // Литеральный ключ jg-... — так же хранит ключ и сам mcode. Файл 0o600.
  doc.setIn([...provider, 'options', 'apiKey'], apiKey);
  doc.setIn([...provider, 'options', 'baseURL'], BASE_URL_OPENAI);
  doc.setIn([...provider, 'options', 'authMode'], 'api-key');

  const models: Record<string, unknown> = {};
  for (const spec of OPENCLAW_MODELS) models[spec.id] = modelEntry(spec);
  doc.setIn([...provider, 'models'], doc.createNode(models));
}

/** Ссылка указывает на НАШ провайдер. */
function isOurs(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.startsWith(`${MCODE_PROVIDER_ID}/`);
}

/**
 * Наша ссылка, модели которой в каталоге больше нет (чужие и актуальные — false).
 * У ссылки бывает хвост `#variant` (docs/tui-capabilities.md) — его отбрасываем.
 */
function isOurStale(ref: unknown): ref is string {
  if (!isOurs(ref)) return false;
  const modelId = ref.slice(MCODE_PROVIDER_ID.length + 1).replace(/#[^#]*$/, '');
  return !CANONICAL_IDS.includes(modelId);
}

/**
 * Модель по умолчанию. Явная пишется всегда; иначе — только если дефолта нет или
 * он указывает на НАШУ модель, которой больше нет в каталоге.
 *
 * Заодно чистим `defaultLightModel` («лёгкая» модель для заголовков и прочей
 * мелочи, формат тот же — config.ts): нашу убранную заменяем моделью этой
 * установки, а не удаляем — иначе короткие задачи молча уехали бы на defaultModel,
 * который может быть чужим (принцип — core/stale-refs.ts).
 *
 * Возвращает строку про дефолт и число вычищенных ссылок.
 */
function editDefaultModel(doc: Document, input: ApplyInput): { line: string; staleRefs: number } {
  const current = doc.getIn(['defaultModel']);
  const target = `${MCODE_PROVIDER_ID}/${input.model}`;
  let staleRefs = isOurStale(current) ? 1 : 0;

  if (isOurStale(doc.getIn(['defaultLightModel']))) {
    doc.setIn(['defaultLightModel'], target);
    staleRefs += 1;
  }

  const hasCurrent = typeof current === 'string' && current.trim() !== '';
  if (!input.modelExplicit && hasCurrent && !isOurStale(current)) {
    return {
      staleRefs,
      line: isOurs(current)
        ? `Kept your current default model (${current}). Switch with --model deepseek|glm|minimax`
        : `Kept your existing default model (${current}). Switch inside MCode: /model`,
    };
  }

  if (current !== target) {
    doc.setIn(['defaultModel'], target);
    for (const key of PAIRED_DEFAULT_KEYS) doc.deleteIn([key]);
  }
  return { staleRefs, line: `Default model: ${target}` };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем ДО бэкапа: неразбираемый конфиг = отказ без единой записи на диск.
  const doc = loadYamlMap(readRaw(configPath), configPath);
  editProvider(doc, configPath, input.apiKey);
  const defaults = editDefaultModel(doc, input);
  const staleNote = staleRefsNote(defaults.staleRefs);

  const text = renderYaml(doc, configPath);

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured provider "${MCODE_PROVIDER_KEY}" in ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI} (API format: ${MCODE_API_FORMAT})`,
      defaults.line,
      ...(staleNote ? [staleNote] : []),
      '',
      // Ключ записан ЛИТЕРАЛЬНО (0o600) — так же его хранит и сам mcode.
      'Your API key was written into config.yaml (file mode 0o600, owner-only) — no',
      'environment variable needed. Keep MCode closed while the installer runs: it',
      'rewrites config.yaml on its own saves. Then start it and check with:',
      `  mcode provider test ${MCODE_PROVIDER_ID}`,
    ],
  };
}

export const minimaxCodeAdapter: Adapter = {
  id: 'minimax-code',
  label: 'MiniMax Code / mcode (OpenAI-compatible)',
  format: 'yaml',
  apiMode: 'openai',
  // Кодовый агент: там, где установщик ПИШЕТ модель в конфиг, по умолчанию идёт
  // DeepSeek V4 Flash (380K/32768) — решение оператора 21.09.2026.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
