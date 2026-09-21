/**
 * Адаптер Kilo Code (https://kilo.ai) — JSONC-конфиг ~/.config/kilo/kilo.jsonc.
 *
 * Новая (OpenCode-based) архитектура Kilo использует тот же формат кастомного
 * провайдера, что opencode (`@ai-sdk/openai-compatible`):
 *   provider.joingonka = { npm, name, options:{baseURL, apiKey:"<литеральный jg-...>"},
 *                          models:{ "<id>":{ name, tool_call, [reasoning], limit } } }
 *   model (top-level) = KILO_DEFAULT_MODEL — только если не задан или указывает
 *                       на нашу убранную модель.
 *
 * Отличия от opencode: $schema = app.kilo.ai; модели несут `tool_call:true`
 * (Kilo требует нативный tool-calling) и `reasoning:true` для reasoning-моделей.
 *
 * Пишем чистый JSON в .jsonc-файл (JSON ⊂ JSONC, Kilo прочитает). Ключ jg-... пишем
 * ЛИТЕРАЛОМ в файл (0o600, owner-only) — env не нужен (раньше была {env:GONKA_API_KEY},
 * но без экспортированной переменной провайдер не поднимался). Слияние не разрушает чужие данные.
 *
 * Достоверность сверена с исходником Kilo (github.com/Kilo-Org/kilocode, main;
 * первая сверка 25.06.2026, повторная 21.09.2026):
 *   - packages/opencode/src/config/config.ts — глобальный loader ищет
 *     ["kilo.jsonc","kilo.json","opencode.jsonc","opencode.json","config.json"]
 *     в каталоге конфига, kilo.jsonc первый/дефолтный; $schema
 *     https://app.kilo.ai/config.json штампуется loader'ом;
 *   - packages/core/src/global.ts — каталог конфига = xdgConfig (npm-пакет
 *     `xdg-basedir`) + "kilo", то есть <XDG_CONFIG_HOME | ~/.config>/kilo на всех
 *     платформах. До 0.4.5 путь был прибит к ~/.config, и при заданном
 *     XDG_CONFIG_HOME установщик писал туда, куда Kilo не смотрит;
 *   - packages/core/src/flag/flag.ts — KILO_CONFIG настоящая переменная Kilo
 *     (путь к файлу конфига), её уважаем первой.
 * Синтаксис {env:VAR} Kilo поддерживает, но мы им не пользуемся (см. выше про
 * литеральный ключ).
 */
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCODE_NPM,
  KILO_PROVIDER_ID,
  KILO_DEFAULT_MODEL,
  kiloModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { isStaleProviderModelRef, type JsonObject } from '../core/merge.js';
import {
  currentPathContext,
  envValue,
  pathApi,
  xdgConfigHome,
  type PathContext,
} from '../core/paths.js';
import { opencodeStaleRefEdits, staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для прунинга устаревших и сброса дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Путь к kilo.jsonc: KILO_CONFIG, иначе <XDG_CONFIG_HOME | ~/.config>/kilo/kilo.jsonc
 * (источники — в шапке файла). Окружение приходит параметром, чтобы XDG-ветку
 * можно было проверить тестом.
 */
export function kiloConfigPath(ctx: PathContext = currentPathContext()): string {
  return (
    envValue(ctx, 'KILO_CONFIG') ?? pathApi(ctx).join(xdgConfigHome(ctx), 'kilo', 'kilo.jsonc')
  );
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return kiloConfigPath();
}

function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = kiloModelEntry(spec) as JsonObject;
  }
  return models;
}

/**
 * Точечные правки kilo.jsonc: блок нашего провайдера (каталог моделей — целиком
 * актуальным набором) и top-level `model`. Файл — JSONC: комментарии и висячие
 * запятые в нём законны, поэтому правим текст, а не пересобираем документ.
 */
function buildEdits(
  existing: JsonObject,
  input: ApplyInput,
): { edits: JsonEdit[]; model: string; staleRefs: number } {
  const provider = ['provider', KILO_PROVIDER_ID];
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://app.kilo.ai/config.json' },
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka' },
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    // Литеральный ключ jg-... (НЕ {env:...}-ссылка): без env-формы Kilo берёт
    // значение как есть → работает БЕЗ внешней переменной. Файл 0o600.
    { path: [...provider, 'options', 'apiKey'], value: input.apiKey },
    { path: [...provider, 'models'], value: buildModels() },
  ];

  const current = existing.model;
  const needsReset =
    typeof current !== 'string' ||
    current.trim() === '' ||
    isStaleProviderModelRef(current, KILO_PROVIDER_ID, CANONICAL_IDS);

  let model: string;
  if (input.modelExplicit) {
    model = `${KILO_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (needsReset) {
    model = KILO_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current as string;
  }

  // Наши убранные модели вне каталога (small_model, модели агентов и команд) —
  // формат тот же, что у opencode, поэтому и правило общее (core/stale-refs.ts).
  // Замена — модель нашего провайдера этой установки: явный --model, иначе дефолт.
  const replacement = input.modelExplicit
    ? `${KILO_PROVIDER_ID}/${input.model}`
    : KILO_DEFAULT_MODEL;
  const staleEdits = opencodeStaleRefEdits(existing, KILO_PROVIDER_ID, CANONICAL_IDS, replacement);
  edits.push(...staleEdits);
  const staleDefault = isStaleProviderModelRef(current, KILO_PROVIDER_ID, CANONICAL_IDS);

  return { edits, model, staleRefs: staleEdits.length + (staleDefault ? 1 : 0) };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Порядок: прочитать → посчитать итоговый текст → и только потом бэкап и
  // запись. Неразбираемый конфиг или примитив на пути правки = отказ без единой
  // записи на диск и без лишнего .bak.
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const { edits, model, staleRefs } = buildEdits(doc.value, input);
  const text = applyJsonEdits(doc.text, edits, configPath);
  const staleNote = staleRefsNote(staleRefs);

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${model}`,
      ...(staleNote ? [staleNote] : []),
      '',
      // Ключ записан ЛИТЕРАЛЬНО в kilo.jsonc (0o600). Раньше писали {env:GONKA_API_KEY}
      // и просили export — но без экспортированной переменной провайдер не поднимался.
      // Это изолированный конфиг Kilo, общие OPENAI_*/ANTHROPIC_* не трогаются.
      'Your API key was written into the config (file mode 0o600, owner-only) — no',
      'environment variable needed. Just restart Kilo to pick up the provider.',
    ],
  };
}

export const kiloAdapter: Adapter = {
  id: 'kilo',
  label: 'Kilo Code (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
