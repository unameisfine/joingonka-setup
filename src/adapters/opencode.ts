/**
 * Адаптер opencode (https://opencode.ai) — НАТИВНАЯ настройка БЕЗ env-переменных.
 *
 * Пишем два файла, ровно как делает сам opencode (`opencode auth login` → Other):
 *   1) ~/.config/opencode/opencode.json (либо уже существующий глобальный файл с
 *      более высоким приоритетом — см. «КАКОЙ файл конфига» ниже) — описание
 *      провайдера `joingonka`
 *      (npm-адаптер @ai-sdk/openai-compatible, baseURL С /v1, models с limit).
 *      apiKey в options НЕ пишем — opencode подтягивает ключ из auth.json по
 *      совпадающему provider-id (apiKey опционален, см. docs/providers).
 *   2) ~/.local/share/opencode/auth.json — нативное хранилище ключей opencode:
 *      { "joingonka": { "type": "api", "key": "jg-..." } } — то же, что пишет
 *      `opencode auth login` → Other → <id> → <ключ>.
 *
 * Почему НЕ через env: opencode читает общие OPENAI_API_KEY / OPENAI_BASE_URL
 * для встроенного openai-провайдера. Перезапись этих переменных в ~/.bashrc /
 * ~/.zshrc уводит НА НАШ gateway ВСЕ прочие OpenAI-совместимые инструменты
 * пользователя (другой агент, скрипты) — ломает их. Нативный путь
 * (auth.json + изолированный provider-id) ничего постороннего не трогает.
 *
 * ⚠️ Provider-id `joingonka` в opencode.json и в auth.json ОБЯЗАН совпадать —
 *   требование opencode (иначе ключ не привяжется к провайдеру).
 *
 * Почему файлами, а не интерактивно: документированный `/connect`→«Other» в
 * opencode сломан (issues #25991/#5937), а `opencode auth login` интерактивен —
 * запись файлов это единственный надёжный путь авто-настройки в одну команду.
 *
 * ★ Правки ТОЧЕЧНЫЕ (core/json-config): меняем только свои пути. Чужие
 * провайдеры, чужие ключи в auth.json, комментарии и форматирование остаются
 * нетронутыми, а файл, который нельзя разобрать, приводит к отказу без записи
 * (до 0.4.5 такой файл заменялся свежим — с потерей ключей других провайдеров).
 *
 * ★ Где opencode ищет файлы (сверено 21.09.2026 по исходнику
 * github.com/anomalyco/opencode, ветка dev — packages/core/src/global.ts,
 * packages/opencode/src/auth/index.ts, packages/core/src/flag/flag.ts — и доке
 * https://opencode.ai/docs/config). Каталоги берутся из npm-пакета
 * `xdg-basedir`, особого случая для Windows и macOS нет:
 *   конфиг: <XDG_CONFIG_HOME | ~/.config>/opencode/
 *   ключи:  <XDG_DATA_HOME | ~/.local/share>/opencode/auth.json
 * До 0.4.5 оба пути были прибиты к домашнему каталогу, и при заданных XDG_*
 * установщик писал туда, куда opencode не смотрит.
 *
 * ★ КАКОЙ файл конфига (сверено 21.09.2026, ветка dev, коммит e059ac59;
 * packages/opencode/src/config/config.ts — loadGlobal, globalConfigFile,
 * mergeConfig). Дока называет один файл — `opencode.json`, но глобальных ТРИ, и
 * opencode сливает их по возрастанию приоритета (remeda mergeDeep):
 *   config.json → opencode.json → opencode.jsonc
 * Сам он пишет в первый существующий из [opencode.jsonc, opencode.json,
 * config.json], а с 12.05.2026 (коммит 48757577) при первом старте СОЗДАЁТ
 * opencode.jsonc, если нет ни одного. До 0.5.0 установщик всегда писал в
 * opencode.json: стоило в .jsonc появиться `model`, как наш `--model` переставал
 * действовать, а установщик и live-проверка рапортовали успех. Теперь пишем в
 * существующий файл с наивысшим приоритетом (core/layered-config.ts); нет ни
 * одного — создаём opencode.json, имя из документации (opencode, найдя его,
 * .jsonc уже не заводит). `model` из файла ниже — выбор пользователя, своим
 * дефолтом его не перебиваем.
 * Наследие прежних версий: наш блок провайдера мог остаться в файле НИЖЕ
 * целевого. Каталоги моделей opencode СЛИВАЕТ, поэтому ушедшая из сети модель
 * вернулась бы в список из старого файла — наш блок и ссылки на убранные модели
 * приводим в порядок и там. Файл, где нашего нет, не трогаем вовсе.
 *
 * Переменные-переопределения:
 *   OPENCODE_CONFIG    — НАСТОЯЩАЯ переменная opencode («Custom config»): путь к
 *                        файлу, который opencode грузит ПОВЕРХ глобальных.
 *                        Задана у пользователя — пишем в неё.
 *   OPENCODE_AUTH_JSON — НАША, opencode её не знает (у него есть только
 *                        OPENCODE_AUTH_CONTENT — содержимое, а не путь). Нужна
 *                        тестам и нестандартным раскладкам; в обычной установке
 *                        не задаётся.
 */
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_MODELS,
  OPENCODE_PROVIDER_ID,
  OPENCODE_NPM,
  OPENCODE_DEFAULT_MODEL,
  opencodeModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
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
  xdgDataHome,
  type PathContext,
} from '../core/paths.js';
import { opencodeStaleRefEdits, staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файлы конфига/ключей — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для прунинга устаревших и сброса дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Глобальные конфиги opencode по УБЫВАНИЮ приоритета загрузки (config.ts, loadGlobal). */
const GLOBAL_CONFIG_NAMES = ['opencode.jsonc', 'opencode.json', 'config.json'] as const;

/** Файл, который создаём, когда нет ни одного, — имя из документации opencode. */
const DEFAULT_CONFIG_NAME = 'opencode.json';

/**
 * Файл конфига для записи и глобальные файлы ниже него (см. шапку). Окружение
 * приходит параметром — так Windows- и XDG-ветки проверяются тестами.
 */
export function opencodeConfigFiles(ctx: PathContext = currentPathContext()): LayeredConfigFiles {
  return pickLayeredConfig({
    dir: pathApi(ctx).join(xdgConfigHome(ctx), 'opencode'),
    names: GLOBAL_CONFIG_NAMES,
    defaultName: DEFAULT_CONFIG_NAME,
    override: envValue(ctx, 'OPENCODE_CONFIG'),
    ctx,
  });
}

/** Пути к файлу конфига и auth.json (см. шапку файла). */
export function opencodePaths(ctx: PathContext = currentPathContext()): {
  config: string;
  auth: string;
} {
  const { join } = pathApi(ctx);
  return {
    config: opencodeConfigFiles(ctx).target,
    auth: envValue(ctx, 'OPENCODE_AUTH_JSON') ?? join(xdgDataHome(ctx), 'opencode', 'auth.json'),
  };
}

/** Путь к файлу конфига; окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return opencodePaths().config;
}

/** Безопасный доступ к вложенному plain-объекту (undefined, если не объект). */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Каталог наших моделей в форме opencode: { "<id>": { name, limit } }. */
function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = opencodeModelEntry(spec) as JsonObject;
  }
  return models;
}

/** true — ссылка на НАШ провайдер, а модели в каталоге уже нет. */
function isStale(ref: unknown): boolean {
  return isStaleProviderModelRef(ref, OPENCODE_PROVIDER_ID, CANONICAL_IDS);
}

/** Блок нашего провайдера; каталог моделей — целиком актуальным набором. */
function providerEdits(): JsonEdit[] {
  const provider = ['provider', OPENCODE_PROVIDER_ID];
  return [
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka (Gonka)' },
    // apiKey в options НЕ пишем: ключ живёт в нативном auth.json.
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    { path: [...provider, 'models'], value: buildModels() },
  ];
}

/**
 * Модель нашего провайдера, действующая в этой установке: явный --model, иначе
 * дефолт провайдера. На неё заменяются ссылки на убранные модели. Top-level
 * `model` пользователя сюда не подставляем — он может быть чужим, а пересаживать
 * НАШЕГО агента на чужого провайдера установщик не вправе.
 */
function replacementFor(input: ApplyInput): string {
  return input.modelExplicit ? `${OPENCODE_PROVIDER_ID}/${input.model}` : OPENCODE_DEFAULT_MODEL;
}

/**
 * Точечные правки ЦЕЛЕВОГО файла: блок нашего провайдера и top-level `model`.
 *
 * `model` пишем, если пользователь задал `--model` явно; иначе — только когда
 * она нигде не задана или указывает на нашу убранную модель. Чужой выбор не
 * трогаем — в том числе сделанный в файле НИЖЕ целевого (`inherited`): он
 * действует, пока целевой файл модель не задаёт.
 */
function buildEdits(
  existing: JsonObject,
  inherited: string | undefined,
  input: ApplyInput,
): { edits: JsonEdit[]; model: string; staleRefs: number } {
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://opencode.ai/config.json' },
    ...providerEdits(),
  ];

  const own = existing.model;
  const current = typeof own === 'string' && own.trim() !== '' ? own : inherited;

  let model: string;
  if (input.modelExplicit) {
    model = `${OPENCODE_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (current === undefined || isStale(current)) {
    model = OPENCODE_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current;
  }

  // Наши убранные модели вне каталога: small_model и модели агентов/команд.
  const staleEdits = opencodeStaleRefEdits(
    existing,
    OPENCODE_PROVIDER_ID,
    CANONICAL_IDS,
    replacementFor(input),
  );
  edits.push(...staleEdits);

  // Устаревшую `model` из файла ниже считает legacyEdits — там она и чинится.
  return { edits, model, staleRefs: staleEdits.length + (isStale(own) ? 1 : 0) };
}

/**
 * Правки файла НИЖЕ целевого — только наше наследие (см. шапку): блок провайдера,
 * если прежняя версия установщика оставила его здесь, и ссылки на убранные
 * модели. Пустой список — в файле нет ничего нашего, и он остаётся нетронутым.
 */
function legacyEdits(existing: JsonObject, input: ApplyInput): { edits: JsonEdit[]; staleRefs: number } {
  const replacement = replacementFor(input);
  const stale: JsonEdit[] = [
    ...(isStale(existing.model) ? [{ path: ['model'], value: replacement }] : []),
    ...opencodeStaleRefEdits(existing, OPENCODE_PROVIDER_ID, CANONICAL_IDS, replacement),
  ];
  const hasOurBlock = asObject(asObject(existing.provider)?.[OPENCODE_PROVIDER_ID]) !== undefined;
  return { edits: [...(hasOurBlock ? providerEdits() : []), ...stale], staleRefs: stale.length };
}

/**
 * Правка auth.json: добавляем наш ключ под provider-id, не касаясь чужих
 * записей. Формат opencode: { "<id>": { "type": "api", "key": "<ключ>" } }.
 */
function buildAuthEdits(apiKey: string): JsonEdit[] {
  return [
    { path: [OPENCODE_PROVIDER_ID, 'type'], value: 'api' },
    { path: [OPENCODE_PROVIDER_ID, 'key'], value: apiKey },
  ];
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // ★ Порядок: прочитать ОБА файла → посчитать ОБА итоговых текста → и только
  //   потом бэкапы и записи. Отказать может чтение (файл не разбирается) и
  //   расчёт правок (примитив на пути: `"provider": "x"`, `"joingonka": "ключ"`
  //   в auth.json старого формата). Отказ на втором файле не должен застать
  //   первый уже переписанным, а диск — с лишним .bak.

  // 1) Файл конфига — провайдер (без apiKey): существующий глобальный файл с
  //    наивысшим приоритетом загрузки (см. шапку), иначе новый opencode.json.
  const ctx = currentPathContext();
  const files = opencodeConfigFiles(ctx);
  const configPath = files.target;
  const configDoc = readJsonConfig(readRaw(configPath), configPath);
  // Файлы ниже целевого: неразбираемый — не отказ (пишем не в него), а заметка.
  const lower = readLowerConfigs(files.lower);

  // 2) auth.json — ключ в нативном хранилище opencode; в нём лежат ключи ДРУГИХ
  //    провайдеров пользователя.
  const authPath = opencodePaths(ctx).auth;
  const authDoc = readJsonConfig(readRaw(authPath), authPath);

  const plan = buildEdits(configDoc.value, inheritedModel(lower.docs), input);
  const configText = applyJsonEdits(configDoc.text, plan.edits, configPath);
  const authText = applyJsonEdits(authDoc.text, buildAuthEdits(input.apiKey), authPath);

  // 3) Наследие в файлах ниже целевого. Тексты — тоже ДО первой записи; файл,
  //    который не меняется, не переписываем и не бэкапим.
  let staleRefs = plan.staleRefs;
  const legacy: Array<{ path: string; text: string }> = [];
  for (const { path, doc } of lower.docs) {
    const found = legacyEdits(doc.value, input);
    staleRefs += found.staleRefs;
    if (found.edits.length === 0) continue;
    const text = applyJsonEdits(doc.text, found.edits, path);
    if (text !== doc.text) legacy.push({ path, text });
  }

  const configBackup = backup(configPath);
  await atomicWrite(configPath, configText, OWNER_ONLY_MODE);

  const authBackup = backup(authPath);
  await atomicWrite(authPath, authText, OWNER_ONLY_MODE);

  const legacyNotes: string[] = [];
  for (const { path, text } of legacy) {
    const legacyBackup = backup(path);
    await atomicWrite(path, text, OWNER_ONLY_MODE);
    legacyNotes.push(
      `Also refreshed the JoinGonka settings an earlier run left in ${path} — opencode merges`,
      `that file with the one above, so retired models would have come back from it.` +
        (legacyBackup != null ? ` Backup: ${legacyBackup}` : ''),
    );
  }
  for (const path of lower.unreadable) {
    legacyNotes.push(
      `Note: ${path} could not be parsed and was left untouched — opencode reads it together with ${configPath}.`,
    );
  }

  const messages = [
    `Configured provider in ${configPath}`,
    `Stored API key in ${authPath} (opencode native store — same as \`opencode auth login\`)`,
    `Base URL: ${BASE_URL_OPENAI}`,
    `Default model: ${plan.model}`,
    ...[staleRefsNote(staleRefs)].filter((line): line is string => line !== null),
    ...legacyNotes,
    '',
    'No environment variables changed — your other OpenAI-compatible tools are left untouched.',
    'Restart opencode to pick up the new provider.',
  ];
  if (authBackup != null) {
    messages.push(`Previous auth.json backed up at ${authBackup}`);
  }

  return {
    configPath,
    backupPath: configBackup,
    wrote: true,
    messages,
  };
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  label: 'opencode (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // ★ Тот же дефолт, что уходит в конфиг (OPENCODE_DEFAULT_MODEL). Оркестратор
  // проверяет живым запросом модель из `defaultModel`; пока поля не было, без
  // `--model` в конфиг писался DeepSeek, а «Verified» выдавалось за MiniMax —
  // проверка подтверждала не ту модель, с которой инструмент пойдёт в сеть.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
