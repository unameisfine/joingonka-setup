/**
 * Адаптер opencode (https://opencode.ai) — НАТИВНАЯ настройка БЕЗ env-переменных.
 *
 * Пишем два файла, ровно как делает сам opencode (`opencode auth login` → Other):
 *   1) ~/.config/opencode/opencode.json — описание провайдера `joingonka`
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
 *   конфиг: <XDG_CONFIG_HOME | ~/.config>/opencode/opencode.json
 *   ключи:  <XDG_DATA_HOME | ~/.local/share>/opencode/auth.json
 * До 0.4.5 оба пути были прибиты к домашнему каталогу, и при заданных XDG_*
 * установщик писал туда, куда opencode не смотрит.
 *
 * Переменные-переопределения:
 *   OPENCODE_CONFIG    — НАСТОЯЩАЯ переменная opencode («Custom config»): путь к
 *                        файлу, который opencode грузит поверх глобального.
 *                        Задана у пользователя — пишем в неё.
 *   OPENCODE_AUTH_JSON — НАША, opencode её не знает (у него есть только
 *                        OPENCODE_AUTH_CONTENT — содержимое, а не путь). Нужна
 *                        тестам и нестандартным раскладкам; в обычной установке
 *                        не задаётся.
 */
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  OPENCODE_PROVIDER_ID,
  OPENCODE_NPM,
  OPENCODE_DEFAULT_MODEL,
  opencodeModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
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

/**
 * Пути к opencode.json и auth.json (см. шапку файла). Окружение приходит
 * параметром — так Windows- и XDG-ветки проверяются тестами на любой машине.
 */
export function opencodePaths(ctx: PathContext = currentPathContext()): {
  config: string;
  auth: string;
} {
  const { join } = pathApi(ctx);
  return {
    config:
      envValue(ctx, 'OPENCODE_CONFIG') ?? join(xdgConfigHome(ctx), 'opencode', 'opencode.json'),
    auth: envValue(ctx, 'OPENCODE_AUTH_JSON') ?? join(xdgDataHome(ctx), 'opencode', 'auth.json'),
  };
}

/** Путь к opencode.json; окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют env). */
function resolvePath(_scope: Scope): string {
  return opencodePaths().config;
}

/** Каталог наших моделей в форме opencode: { "<id>": { name, limit } }. */
function buildModels(): JsonObject {
  const models: JsonObject = {};
  for (const spec of OPENCLAW_MODELS) {
    models[spec.id] = opencodeModelEntry(spec) as JsonObject;
  }
  return models;
}

/**
 * Точечные правки opencode.json: блок нашего провайдера (каталог моделей —
 * целиком актуальным набором) и top-level `model`.
 *
 * `model` пишем, если пользователь задал `--model` явно; иначе — только когда
 * он пуст или указывает на нашу убранную модель. Чужой выбор не трогаем.
 */
function buildEdits(
  existing: JsonObject,
  input: ApplyInput,
): { edits: JsonEdit[]; model: string; staleRefs: number } {
  const provider = ['provider', OPENCODE_PROVIDER_ID];
  const edits: JsonEdit[] = [
    { path: ['$schema'], value: 'https://opencode.ai/config.json' },
    { path: [...provider, 'npm'], value: OPENCODE_NPM },
    { path: [...provider, 'name'], value: 'JoinGonka (Gonka)' },
    // apiKey в options НЕ пишем: ключ живёт в нативном auth.json.
    { path: [...provider, 'options', 'baseURL'], value: BASE_URL_OPENAI },
    { path: [...provider, 'models'], value: buildModels() },
  ];

  const current = existing.model;
  const needsReset =
    typeof current !== 'string' ||
    current.trim() === '' ||
    isStaleProviderModelRef(current, OPENCODE_PROVIDER_ID, CANONICAL_IDS);

  let model: string;
  if (input.modelExplicit) {
    model = `${OPENCODE_PROVIDER_ID}/${input.model}`;
    edits.push({ path: ['model'], value: model });
  } else if (needsReset) {
    model = OPENCODE_DEFAULT_MODEL;
    edits.push({ path: ['model'], value: model });
  } else {
    model = current as string;
  }

  // Наши убранные модели вне каталога: small_model и модели агентов/команд.
  // Заменяем на модель нашего провайдера, действующую в этой установке: явный
  // --model, иначе дефолт провайдера. Top-level `model` пользователя сюда не
  // подставляем — он может быть чужим, а пересаживать НАШЕГО агента на чужого
  // провайдера установщик не вправе.
  const replacement = input.modelExplicit
    ? `${OPENCODE_PROVIDER_ID}/${input.model}`
    : OPENCODE_DEFAULT_MODEL;
  const staleEdits = opencodeStaleRefEdits(
    existing,
    OPENCODE_PROVIDER_ID,
    CANONICAL_IDS,
    replacement,
  );
  edits.push(...staleEdits);
  const staleDefault = isStaleProviderModelRef(current, OPENCODE_PROVIDER_ID, CANONICAL_IDS);

  return { edits, model, staleRefs: staleEdits.length + (staleDefault ? 1 : 0) };
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

  // 1) opencode.json — провайдер (без apiKey).
  const configPath = resolvePath(input.scope);
  const configDoc = readJsonConfig(readRaw(configPath), configPath);

  // 2) auth.json — ключ в нативном хранилище opencode; в нём лежат ключи ДРУГИХ
  //    провайдеров пользователя.
  const authPath = opencodePaths().auth;
  const authDoc = readJsonConfig(readRaw(authPath), authPath);

  const { edits, model, staleRefs } = buildEdits(configDoc.value, input);
  const configText = applyJsonEdits(configDoc.text, edits, configPath);
  const authText = applyJsonEdits(authDoc.text, buildAuthEdits(input.apiKey), authPath);

  const configBackup = backup(configPath);
  await atomicWrite(configPath, configText, OWNER_ONLY_MODE);

  const authBackup = backup(authPath);
  await atomicWrite(authPath, authText, OWNER_ONLY_MODE);

  const messages = [
    `Configured provider in ${configPath}`,
    `Stored API key in ${authPath} (opencode native store — same as \`opencode auth login\`)`,
    `Base URL: ${BASE_URL_OPENAI}`,
    `Default model: ${model}`,
    ...[staleRefsNote(staleRefs)].filter((line): line is string => line !== null),
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
  resolvePath,
  apply,
};
