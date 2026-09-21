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
 * первая сверка 25.06.2026, повторная 21.09.2026 — коммит 3873ac30):
 *   - packages/opencode/src/config/config.ts — глобальных файлов ПЯТЬ, и loadGlobal
 *     сливает их по возрастанию приоритета (remeda mergeDeep):
 *       config.json → kilo.json → kilo.jsonc → opencode.json → opencode.jsonc
 *     ⚠ Это НЕ тот порядок, в котором Kilo выбирает файл для СВОЕЙ записи
 *     (globalConfigFile: первый существующий из ["kilo.jsonc","kilo.json",
 *     "opencode.jsonc","opencode.json","config.json"], при отсутствии всех
 *     создаётся kilo.jsonc): opencode.json(c) в каталоге Kilo ПЕРЕКРЫВАЕТ
 *     kilo.jsonc. Нам важно, чтобы записанное действовало, поэтому пишем в
 *     существующий файл с наивысшим приоритетом ЗАГРУЗКИ (core/layered-config.ts);
 *     нет ни одного — создаём kilo.jsonc, как сам Kilo. До 0.5.0 установщик всегда
 *     писал kilo.jsonc: рядом с рабочим kilo.json появлялся второй конфиг, а
 *     `model` из opencode.json(c) молча перекрывала наш `--model`. `model` из
 *     файла ниже — выбор пользователя, своим дефолтом его не перебиваем. Наш
 *     прежний блок в файле ниже целевого приводим в порядок на месте: каталоги
 *     моделей Kilo сливает, и убранная модель вернулась бы оттуда. $schema
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
  CODING_AGENT_DEFAULT_MODEL,
  OPENCODE_NPM,
  KILO_PROVIDER_ID,
  KILO_DEFAULT_MODEL,
  kiloModelEntry,
} from '../constants.js';
import { catalogFor, catalogIds } from '../core/catalog.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { asObject } from '../core/json-shape.js';
import {
  inheritedModel,
  pickLayeredConfig,
  readLowerConfigs,
  type LayeredConfigFiles,
} from '../core/layered-config.js';
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

/** Глобальные конфиги Kilo по УБЫВАНИЮ приоритета загрузки (config.ts, loadGlobal). */
const GLOBAL_CONFIG_NAMES = [
  'opencode.jsonc',
  'opencode.json',
  'kilo.jsonc',
  'kilo.json',
  'config.json',
] as const;

/** Файл, который создаём, когда нет ни одного, — его же заводит сам Kilo. */
const DEFAULT_CONFIG_NAME = 'kilo.jsonc';

/**
 * Файл конфига для записи и глобальные файлы ниже него: KILO_CONFIG (слой поверх
 * глобальных), иначе существующий файл каталога <XDG_CONFIG_HOME | ~/.config>/kilo
 * с наивысшим приоритетом, иначе kilo.jsonc (источники — в шапке файла).
 * Окружение приходит параметром, чтобы XDG-ветку можно было проверить тестом.
 */
export function kiloConfigFiles(ctx: PathContext = currentPathContext()): LayeredConfigFiles {
  return pickLayeredConfig({
    dir: pathApi(ctx).join(xdgConfigHome(ctx), 'kilo'),
    names: GLOBAL_CONFIG_NAMES,
    defaultName: DEFAULT_CONFIG_NAME,
    override: envValue(ctx, 'KILO_CONFIG'),
    ctx,
  });
}

/** Путь к файлу конфига, в который пишем. */
export function kiloConfigPath(ctx: PathContext = currentPathContext()): string {
  return kiloConfigFiles(ctx).target;
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return kiloConfigPath();
}

/**
 * Каталог наших моделей: модели сети плюс явно запрошенная модель вне каталога
 * (core/catalog.ts) — дефолт, которого нет в каталоге провайдера, Kilo не находит.
 */
function buildModels(input: ApplyInput): JsonObject {
  const models: JsonObject = {};
  for (const spec of catalogFor(input)) {
    models[spec.id] = kiloModelEntry(spec) as JsonObject;
  }
  return models;
}

/** true — ссылка на НАШ провайдер, а модели в каталоге этой установки нет. */
function isStale(ref: unknown, liveIds: readonly string[]): boolean {
  return isStaleProviderModelRef(ref, KILO_PROVIDER_ID, liveIds);
}

/** Блок нашего провайдера; каталог моделей — целиком актуальным набором. */
function providerEdits(input: ApplyInput): JsonEdit[] {
  const provider = ['provider', KILO_PROVIDER_ID];
  return [
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka' },
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    // Литеральный ключ jg-... (НЕ {env:...}-ссылка): без env-формы Kilo берёт
    // значение как есть → работает БЕЗ внешней переменной. Файл 0o600.
    { path: [...provider, 'options', 'apiKey'], value: input.apiKey },
    { path: [...provider, 'models'], value: buildModels(input) },
  ];
}

/**
 * Модель нашего провайдера этой установки: явный --model, иначе дефолт. На неё
 * заменяются ссылки на убранные модели (small_model, модели агентов и команд) —
 * формат тот же, что у opencode, поэтому и правило общее (core/stale-refs.ts).
 */
function replacementFor(input: ApplyInput): string {
  return input.modelExplicit ? `${KILO_PROVIDER_ID}/${input.model}` : KILO_DEFAULT_MODEL;
}

/**
 * Точечные правки ЦЕЛЕВОГО файла: блок нашего провайдера (каталог моделей —
 * целиком актуальным набором) и top-level `model`. Файл — JSONC: комментарии и
 * висячие запятые в нём законны, поэтому правим текст, а не пересобираем документ.
 *
 * `model` пишем при явном `--model`; иначе — только когда она нигде не задана или
 * указывает на нашу убранную модель. Выбор пользователя из файла НИЖЕ целевого
 * (`inherited`) действует, пока целевой модель не задаёт, — его не перебиваем.
 */
function buildEdits(
  existing: JsonObject,
  inherited: string | undefined,
  input: ApplyInput,
): { edits: JsonEdit[]; model: string; staleRefs: number } {
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://app.kilo.ai/config.json' },
    ...providerEdits(input),
  ];
  const liveIds = catalogIds(input);

  const own = existing.model;
  const current = typeof own === 'string' && own.trim() !== '' ? own : inherited;

  let model: string;
  if (input.modelExplicit) {
    model = `${KILO_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (current === undefined || isStale(current, liveIds)) {
    model = KILO_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current;
  }

  const staleEdits = opencodeStaleRefEdits(
    existing,
    KILO_PROVIDER_ID,
    liveIds,
    replacementFor(input),
  );
  edits.push(...staleEdits);

  // Устаревшую `model` из файла ниже считает legacyEdits — там она и чинится.
  return { edits, model, staleRefs: staleEdits.length + (isStale(own, liveIds) ? 1 : 0) };
}

/**
 * Правки файла НИЖЕ целевого — только наше наследие (см. шапку): блок провайдера,
 * если прежняя версия установщика оставила его здесь (заодно в нём обновляется
 * ключ — старый литерал в забытом файле ни к чему), и ссылки на убранные модели.
 * Пустой список — нашего в файле нет, и он остаётся нетронутым.
 */
function legacyEdits(existing: JsonObject, input: ApplyInput): { edits: JsonEdit[]; staleRefs: number } {
  const replacement = replacementFor(input);
  const liveIds = catalogIds(input);
  const stale: JsonEdit[] = [
    ...(isStale(existing.model, liveIds) ? [{ path: ['model'], value: replacement }] : []),
    ...opencodeStaleRefEdits(existing, KILO_PROVIDER_ID, liveIds, replacement),
  ];
  const hasOurBlock = asObject(asObject(existing.provider)?.[KILO_PROVIDER_ID]) !== undefined;
  return {
    edits: [...(hasOurBlock ? providerEdits(input) : []), ...stale],
    staleRefs: stale.length,
  };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const files = kiloConfigFiles();
  const configPath = files.target;

  // Порядок: прочитать → посчитать ВСЕ итоговые тексты → и только потом бэкапы и
  // записи. Неразбираемый конфиг или примитив на пути правки = отказ без единой
  // записи на диск и без лишнего .bak.
  const doc = readJsonConfig(readRaw(configPath), configPath);
  // Файлы ниже целевого: неразбираемый — не отказ (пишем не в него), а заметка.
  const lower = readLowerConfigs(files.lower);
  const plan = buildEdits(doc.value, inheritedModel(lower.docs), input);
  const text = applyJsonEdits(doc.text, plan.edits, configPath);

  // Наследие в файлах ниже целевого; файл, который не меняется, не переписываем.
  let staleRefs = plan.staleRefs;
  const legacy: Array<{ path: string; text: string }> = [];
  for (const { path, doc: lowerDoc } of lower.docs) {
    const found = legacyEdits(lowerDoc.value, input);
    staleRefs += found.staleRefs;
    if (found.edits.length === 0) continue;
    const lowerText = applyJsonEdits(lowerDoc.text, found.edits, path);
    if (lowerText !== lowerDoc.text) legacy.push({ path, text: lowerText });
  }
  const staleNote = staleRefsNote(staleRefs);

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  const legacyNotes: string[] = [];
  for (const { path, text: lowerText } of legacy) {
    const legacyBackup = backup(path);
    // В блоке лежит литеральный ключ — права только владельцу, как у целевого файла.
    await atomicWrite(path, lowerText, OWNER_ONLY_MODE);
    legacyNotes.push(
      `Also refreshed the JoinGonka settings an earlier run left in ${path} — Kilo merges`,
      `that file with the one above, so retired models would have come back from it.` +
        (legacyBackup != null ? ` Backup: ${legacyBackup}` : ''),
    );
  }
  for (const path of lower.unreadable) {
    legacyNotes.push(
      `Note: ${path} could not be parsed and was left untouched — Kilo reads it together with ${configPath}.`,
    );
  }

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Default model: ${plan.model}`,
      ...(staleNote ? [staleNote] : []),
      ...legacyNotes,
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
  // ★ Тот же дефолт, что уходит в конфиг (KILO_DEFAULT_MODEL). Оркестратор
  // проверяет живым запросом модель из `defaultModel`; пока поля не было, без
  // `--model` в конфиг писался DeepSeek, а «Verified» выдавалось за MiniMax —
  // проверка подтверждала не ту модель, с которой инструмент пойдёт в сеть.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
