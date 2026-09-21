/**
 * Адаптер Kimi Code CLI (Moonshot AI, https://github.com/MoonshotAI/kimi-code,
 * команда `kimi`) — TOML ~/.kimi-code/config.toml.
 *
 * Что прописываем (OpenAI-режим, /v1/chat/completions):
 *   [providers.joingonka]
 *     type = "openai"  base_url = "https://gate.joingonka.ai/v1"  api_key = "<ключ>"
 *   [models."joingonka/<id модели>"]            — по таблице на каждую модель сети
 *     provider / model / max_context_size / max_output_size / capabilities / display_name
 *   default_model = "joingonka/<id модели>"     — только когда дефолт становится нашим.
 *
 * ★ Первоисточники (сверено 21.09.2026, @moonshot-ai/kimi-code 2.0.2 от 19.09.2026,
 *   main 0523bafb):
 *   https://moonshotai.github.io/kimi-code/en/configuration/providers.html   — типы
 *     провайдеров, приоритет учётных данных, примеры;
 *   https://moonshotai.github.io/kimi-code/en/configuration/config-files.html — путь,
 *     поля `providers` / `models` / `secondary_model`, правило про кавычки в ключах;
 *   https://moonshotai.github.io/kimi-code/en/configuration/overrides.html    — ключи
 *     провайдера НЕ читаются из окружения оболочки, проектного конфига нет;
 *   https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html — каталог
 *     данных по платформам, KIMI_CODE_HOME;
 *   сверка настоящим CLI 2.0.2 в песочнице: `kimi provider list --json` разобрал файл
 *     ровно в те провайдер и три модели, что мы пишем, а `kimi -p` дошёл до шлюза
 *     и получил его «401 Invalid API key» на заведомо неверный ключ;
 *   исходники: packages/agent-core-v2/src/app/kosongConfig/configSection.ts (схемы),
 *     packages/agent-core-v2/src/app/bootstrap/bootstrap.ts (resolveKimiHome, права 0o700),
 *     packages/oauth/src/provider-credential.ts (конфликты учётных данных),
 *     packages/agent-core-v2/src/llm-adapter/model/completion-budget.ts (max_output_size → max_tokens),
 *     packages/kosong/src/providers/capability-registry.ts (возможности по имени модели).
 *
 * ⚠ НЕ ~/.kimi/config.toml: это каталог прежнего Python-клиента `kimi-cli`, он
 * заархивирован («will stop working»), а Kimi Code 2.x читает только ~/.kimi-code
 * (данные из ~/.kimi он однократно переносит сам).
 *
 * ── Ключ ────────────────────────────────────────────────────────────────────
 * `api_key` — «API key, written in plain text in the config file», основной способ
 * инструмента; из окружения оболочки Kimi Code ключи провайдеров не читает вовсе
 * (кроме явно названной переменной `api_key_env`). Пишем литералом, файл 0o600.
 * `api_key` несовместим с `api_key_env` и с `oauth` — конфиг с парой отвергается
 * как конфликт. Поэтому `api_key_env` из нашей таблицы убираем, а на `oauth`
 * (на нашем провайдере ему взяться неоткуда) отказываем, ничего не записав.
 *
 * ── Модели ──────────────────────────────────────────────────────────────────
 * Алиас — `joingonka/<id>`, как у собственных алиасов инструмента (`kimi-code/k3`);
 * в TOML такой ключ пишется в кавычках. «Наши» записи — те, у кого
 * `provider = "joingonka"`, под любым алиасом: дока прямо предлагает заводить
 * варианты одной модели (другой effort), поэтому запись пользователя с живой
 * моделью не трогаем. Запись с моделью, которой в сети больше нет, удаляем.
 * Лимиты — реальные: `max_context_size` — окно, `max_output_size` — потолок ответа
 * (в 2.0.2 он уходит в `max_tokens` у всех типов провайдеров; без него Kimi Code
 * просил бы до 131072 токенов ответа). Возможности у незнакомых имён инструмент не
 * угадывает (реестр знает только gpt-*, o*, claude-*, gemini-*), поэтому
 * `capabilities` объявляем явно: `tool_use` всем, `thinking` — reasoning-моделям.
 * Правим ключи по одному: пользовательские поля записи и её подтаблица
 * `[models."<алиас>".overrides]` (место для ручных переопределений) целы.
 * Автообновление списка моделей (`/models`) наш провайдер не задевает — оно
 * работает только для managed-аккаунта Kimi и импортированных реестров.
 *
 * ── Ссылки на ушедшую модель ────────────────────────────────────────────────
 * На алиас ссылаются `default_model` и раздел `[secondary_model]` (модель
 * сабагентов: `default_model` и пул `[secondary_model.models]`). По документации
 * висячая ссылка там — ошибка конфигурации, с которой сессия не создаётся
 * («Configuration errors fail loudly … fail at startup»; в исходниках —
 * assertValidSubagentModelPool, код CONFIG_INVALID). В print-режиме (`kimi -p`)
 * версии 2.0.2 отказ не воспроизвёлся, но полагаться на это нельзя. Поэтому вместе
 * с записью чистим и ссылки: дефолт сабагентов переводим на модель этой установки,
 * ключ пула убираем, а если дефолт пула заменён — добавляем его в пул (он обязан
 * быть одним из ключей).
 *
 * ── Модель по умолчанию ─────────────────────────────────────────────────────
 *   явный --model → пишем всегда; `default_model` пуст → ставим себя;
 *   алиас чужого провайдера → не трогаем, печатаем `kimi -m "<алиас>"`;
 *   наш алиас с живой моделью → не трогаем; с ушедшей — сбрасываем на дефолт.
 *
 * Путь один для обоих scope: проектного конфига у Kimi Code нет. Каталог данных:
 * непустой KIMI_CODE_HOME, иначе ~/.kimi-code (на Windows — %USERPROFILE%\.kimi-code).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
  OPENCLAW_MODELS,
  type OpenClawModelSpec,
} from '../constants.js';
import { catalogFor } from '../core/catalog.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { nonEmptyString } from '../core/json-shape.js';
import { currentPathContext, envValue, pathApi, type PathContext } from '../core/paths.js';
import { staleRefsNote } from '../core/stale-refs.js';
import {
  applyTomlEdits,
  readTomlConfig,
  tomlTable,
  type TomlEdit,
  type TomlEditValue,
  type TomlTable,
} from '../core/toml-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id нашего провайдера в `providers` и префикс алиасов моделей. */
const KIMI_PROVIDER_ID = 'joingonka';

/** Тип провайдера: OpenAI Chat Completions — наш зрелый роут. */
const KIMI_PROVIDER_TYPE = 'openai';

const PROVIDER_TABLE = ['providers', KIMI_PROVIDER_ID] as const;

/** Права: файл с ключом — только владелец; каталог данных — как создаёт его сам инструмент. */
const OWNER_ONLY_MODE = 0o600;
const DATA_DIR_MODE = 0o700;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Путь к config.toml. Окружение приходит параметром — чужая платформа
 * проверяется тестом на любой машине.
 */
export function kimiCodeConfigPath(ctx: PathContext = currentPathContext()): string {
  const { join, resolve } = pathApi(ctx);
  const custom = envValue(ctx, 'KIMI_CODE_HOME');
  return join(custom !== undefined ? resolve(custom) : join(ctx.home, '.kimi-code'), 'config.toml');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function resolvePath(_scope: Scope): string {
  return kimiCodeConfigPath();
}

/** Алиас модели в `[models]`: `joingonka/<id>`. */
function aliasOf(modelId: string): string {
  return `${KIMI_PROVIDER_ID}/${modelId}`;
}

/** Правки одной таблицы модели — поля `[models.<alias>]` из документации. */
function modelEdits(spec: OpenClawModelSpec): TomlEdit[] {
  const table = ['models', aliasOf(spec.id)];
  const field = (key: string, value: TomlEditValue): TomlEdit => ({ op: 'set', table, key, value });
  return [
    field('provider', KIMI_PROVIDER_ID),
    field('model', spec.id),
    field('max_context_size', spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW),
    field('max_output_size', spec.maxTokens),
    field('capabilities', spec.reasoning ? ['thinking', 'tool_use'] : ['tool_use']),
    field('display_name', spec.name),
  ];
}

/** Алиасы наших записей, чьей модели в сети больше нет (см. «Модели» в шапке). */
function staleAliases(models: TomlTable, liveIds: ReadonlySet<string>): string[] {
  return Object.entries(models).flatMap(([name, entry]) => {
    const record = tomlTable(entry);
    const modelId = nonEmptyString(record?.model);
    const stale = record?.provider === KIMI_PROVIDER_ID && modelId !== undefined && !liveIds.has(modelId);
    return stale ? [name] : [];
  });
}

interface DefaultPlan {
  edits: TomlEdit[];
  lines: string[];
  /** Чужой дефолт, который мы заменили; undefined — переключать было нечего. */
  switchedFrom?: string;
  /** Дефолт указывал на нашу ушедшую модель. */
  staleDefault: boolean;
}

/** Решение по дефолтной модели (правила — в шапке файла). */
function planDefault(root: TomlTable, models: TomlTable, input: ApplyInput): DefaultPlan {
  const target = aliasOf(input.model);
  const current = nonEmptyString(root.default_model);
  const entry = current !== undefined ? tomlTable(models[current]) : undefined;
  // Наш ли текущий дефолт: по провайдеру записи, а для висячего алиаса — по префиксу.
  const ours =
    entry !== undefined
      ? entry.provider === KIMI_PROVIDER_ID
      : current?.startsWith(`${KIMI_PROVIDER_ID}/`) === true;
  const currentId =
    entry !== undefined ? nonEmptyString(entry.model) : current?.slice(KIMI_PROVIDER_ID.length + 1);
  const live = ours && currentId !== undefined && CANONICAL_IDS.includes(currentId);
  const staleDefault = ours && !live && current !== target;

  const takeOver = (): DefaultPlan => ({
    edits: [{ op: 'set', table: [], key: 'default_model', value: target }],
    lines: [
      `Default model: ${target}` +
        (staleDefault ? ` — replaces ${current}, which the Gonka network no longer serves` : ''),
    ],
    switchedFrom: current !== undefined && !ours ? current : undefined,
    staleDefault,
  });

  if (input.modelExplicit || current === undefined) return takeOver();
  if (!ours) {
    return {
      edits: [],
      lines: [
        `Kept your default model (${current}).`,
        `      Use a JoinGonka model for one session: kimi -m "${target}" — or pick it with /model.`,
        '      Make it the default: re-run with --model deepseek|glm|minimax',
      ],
      staleDefault: false,
    };
  }
  if (live) {
    return {
      edits: [],
      lines: [`Kept your current default model: ${current}`, '      Switch with --model deepseek|glm|minimax'],
      staleDefault: false,
    };
  }
  return takeOver();
}

/**
 * Ссылки `[secondary_model]` на удаляемые алиасы (см. «Ссылки на ушедшую модель»).
 * Возвращает правки и число вычищенных ссылок.
 */
function secondaryEdits(
  root: TomlTable,
  removed: readonly string[],
  replacement: string,
): { edits: TomlEdit[]; count: number } {
  const secondary = tomlTable(root.secondary_model);
  if (!secondary || removed.length === 0) return { edits: [], count: 0 };

  const edits: TomlEdit[] = [];
  const pool = tomlTable(secondary.models);
  const poolKeys = new Set(pool ? Object.keys(pool) : []);
  for (const name of removed) {
    if (!poolKeys.has(name)) continue;
    edits.push({ op: 'remove', table: ['secondary_model', 'models'], key: name });
    poolKeys.delete(name);
  }

  const current = nonEmptyString(secondary.default_model);
  if (current !== undefined && removed.includes(current)) {
    edits.push({ op: 'set', table: ['secondary_model'], key: 'default_model', value: replacement });
    // Дефолт пула обязан быть одним из его ключей; пустая строка — «без подсказки».
    if (pool && !poolKeys.has(replacement)) {
      edits.push({ op: 'set', table: ['secondary_model', 'models'], key: replacement, value: '' });
    }
  }
  return { edits, count: edits.filter((edit) => edit.op !== 'set' || edit.key === 'default_model').length };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем, проверяем и считаем итоговый текст ДО бэкапа: любой отказ оставляет
  // диск нетронутым (ни записи, ни лишнего .bak).
  const doc = readTomlConfig(readRaw(configPath), configPath);
  const provider = tomlTable(tomlTable(doc.value.providers)?.[KIMI_PROVIDER_ID]);
  if (provider?.oauth !== undefined) {
    throw new Error(
      `${configPath}: [${PROVIDER_TABLE.join('.')}] carries an "oauth" reference, and Kimi Code rejects ` +
        'a provider that has both oauth and api_key. Nothing was written — remove the oauth entry ' +
        '(JoinGonka uses a plain API key) and run the installer again.',
    );
  }

  const models = tomlTable(doc.value.models) ?? {};
  const specs = catalogFor(input);
  const removed = staleAliases(models, new Set(specs.map((spec) => spec.id)));
  const defaults = planDefault(doc.value, models, input);
  const secondary = secondaryEdits(doc.value, removed, aliasOf(input.model));
  const hadEnvKey = provider?.api_key_env !== undefined;

  const setProvider = (key: string, value: string): TomlEdit => ({
    op: 'set',
    table: PROVIDER_TABLE,
    key,
    value,
  });
  const text = applyTomlEdits(
    doc.text,
    [
      ...defaults.edits,
      setProvider('type', KIMI_PROVIDER_TYPE),
      setProvider('base_url', BASE_URL_OPENAI),
      setProvider('api_key', input.apiKey),
      // api_key и api_key_env вместе Kimi Code отвергает как конфликт.
      { op: 'remove', table: PROVIDER_TABLE, key: 'api_key_env' },
      ...specs.flatMap(modelEdits),
      // Сначала ссылки, потом сами записи: промежуточное состояние не важно, но так
      // порядок совпадает с тем, как это читается.
      ...secondary.edits,
      ...removed.map((name): TomlEdit => ({ op: 'removeTable', table: ['models', name] })),
    ],
    configPath,
  );

  const backupPath = backup(configPath);
  // Каталог данных инструмент создаёт с правами 0o700 — повторяем, если создаём его мы.
  const dataDir = dirname(configPath);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  const staleNote = staleRefsNote(removed.length + (defaults.staleDefault ? 1 : 0) + secondary.count);
  const messages = [
    `Configured provider "${KIMI_PROVIDER_ID}" in ${configPath}`,
    `Base URL: ${BASE_URL_OPENAI} (provider type "${KIMI_PROVIDER_TYPE}" — Chat Completions)`,
    `Models: ${specs.map((spec) => aliasOf(spec.id)).join(', ')} — with their real context and output limits`,
    ...defaults.lines,
    ...(staleNote ? [staleNote] : []),
  ];

  if (defaults.switchedFrom !== undefined) {
    messages.push(
      `Switched Kimi Code to JoinGonka — this replaced your previous default_model "${defaults.switchedFrom}".`,
      `To go back: pick it again with /model${backupPath != null ? `, or restore ${backupPath}` : ''}.`,
    );
  }

  messages.push(
    '',
    `Your API key was written into [${PROVIDER_TABLE.join('.')}] as api_key (file mode 0600) — the place`,
    'Kimi Code itself reads provider keys from; it never takes them from the shell environment.',
  );
  if (hadEnvKey) {
    messages.push('Removed api_key_env from that table: Kimi Code rejects a provider that sets both.');
  }
  messages.push(
    `Switch models inside Kimi Code with /model, or per session: kimi -m "${aliasOf(input.model)}"`,
  );

  return { configPath, backupPath, wrote: true, messages };
}

export const kimiCodeAdapter: Adapter = {
  id: 'kimi-code',
  label: 'Kimi Code CLI (OpenAI-compatible)',
  format: 'toml',
  apiMode: 'openai',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
