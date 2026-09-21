/**
 * Адаптер Codex CLI (OpenAI, https://github.com/openai/codex) — TOML
 * ~/.codex/config.toml. Тот же файл читает IDE-расширение Codex («The CLI and
 * IDE extension share the same configuration layers»).
 *
 * Что прописываем:
 *   [model_providers.joingonka]
 *     name = "JoinGonka"                      — обязателен (пустое имя Codex отвергает)
 *     base_url = "https://gate.joingonka.ai/v1"
 *     wire_api = "responses"                  — единственное допустимое значение
 *     experimental_bearer_token = "<ключ>"    — ключ ЛИТЕРАЛОМ, см. «Ключ»
 *   model / model_provider / model_context_window (верхний уровень) — только когда
 *     дефолтная модель становится нашей, см. «Модель по умолчанию».
 *
 * ★ Первоисточники (сверено 21.09.2026; main 20cdcb01 от 21.09.2026 и релиз
 *   rust-v0.155.1 от 18.09.2026 — поля и порядок авторизации совпадают):
 *   https://developers.openai.com/codex/config-basic     — где лежит файл, слои конфигурации, IDE;
 *   https://developers.openai.com/codex/config-advanced  — «Custom model providers», профили,
 *     разовые переопределения `-c`, что запрещено проектному .codex/config.toml;
 *   https://developers.openai.com/codex/config-reference — таблица ключей
 *     (`model_providers.<id>.experimental_bearer_token` — «Direct bearer token for the
 *     provider (discouraged; use env_key)»);
 *   https://developers.openai.com/codex/config-sample    — полный пример файла;
 *   сверка настоящим бинарником 0.155.1 в песочнице: `codex exec` выбрал провайдера и
 *     модель из нашего файла, дошёл до https://gate.joingonka.ai/v1/responses и получил
 *     «401 Invalid API key» на заведомо неверный ключ (без ключа шлюз отвечает иначе —
 *     значит, литеральный токен уходит в Authorization); `codex mcp list` подтвердил
 *     отказы загрузки: auth + токен, пустой name, `wire_api = "chat"`; BOM он принимает;
 *   исходники: codex-rs/model-provider-info/src/lib.rs (ModelProviderInfo, WireApi, validate),
 *     codex-rs/model-provider/src/auth.rs (bearer_auth_for_provider),
 *     codex-rs/model-provider/src/provider.rs (remote_compaction),
 *     codex-rs/config/src/config_toml.rs (ConfigToml, validate_model_providers),
 *     codex-rs/models-manager/src/model_info.rs (запасные метаданные модели),
 *     codex-rs/core/src/client.rs (тело запроса Responses),
 *     codex-rs/utils/home-dir/src/lib.rs (CODEX_HOME).
 *
 * ── Ключ ────────────────────────────────────────────────────────────────────
 * Полей для ключа три: `env_key` (ИМЯ переменной окружения), `auth` (команда,
 * печатающая токен) и `experimental_bearer_token` (значение). Литерал умеет только
 * последнее; канон установщика — ключ в родном конфиге, окружение не трогаем.
 * ⚠ Риск: поле названо «experimental», дока помечает его «discouraged» из
 * соображений безопасности (ключ открытым текстом в файле — ровно то, что нам и
 * нужно, файл 0o600). Оно есть и в релизе, и в main, описано в справочнике и в
 * примере конфига, но переименовать его могут без предупреждения — тогда запросы
 * пойдут без ключа (401), лечится повторной установкой новой версией.
 *
 * Порядок у Codex (bearer_auth_for_provider): сначала `env_key` — и если
 * переменной нет, это ОШИБКА, до токена дело не доходит; есть — литерал молча
 * проигрывает. Поэтому `env_key` из нашей таблицы убираем. А `auth` Codex вместе
 * с токеном отвергает при загрузке (validate), поэтому при командной авторизации
 * ключ НЕ пишем и auth не трогаем — как у Goose.
 *
 * ── Совместимость со stateless /v1/responses шлюза ──────────────────────────
 * Codex по HTTP всегда шлёт `store: false` и НЕ шлёт `previous_response_id`
 * (он есть только в WebSocket-транспорте, а `supports_websockets` у своих
 * провайдеров по умолчанию false) — флагов «отключить хранение» в конфиге нет и
 * не нужно (`disable_response_storage` из старых инструкций удалён). Серверное
 * сжатие истории (`/responses/compact`) включается только для провайдера с именем
 * "OpenAI" или Azure; у остальных сжатие локальное — отсюда жёсткое
 * `name = "JoinGonka"`, которое мы возвращаем, даже если человек его переименовал.
 * `query_params` и `http_headers` шлюзу не нужны.
 *
 * ── Лимиты модели ───────────────────────────────────────────────────────────
 * Для модели, которой нет во встроенном каталоге Codex, берутся запасные
 * метаданные: окно 272000 и оно же потолок — `model_context_window` выше него
 * Codex урежет сам. Пишем РЕАЛЬНОЕ окно модели: для MiniMax (200000) это
 * обязательно, иначе Codex считал бы окно равным 272000 и не сжимал историю
 * вовремя; для DeepSeek и GLM действовать будет 272000. Порог авто-сжатия —
 * 90 % окна по умолчанию, отдельно не задаём. Потолка ответа в конфиге нет
 * (`model_max_output_tokens` удалён), шлюз ограничивает выдачу сам.
 * Ключ `model_context_window` ГЛОБАЛЬНЫЙ (не пер-провайдерный), поэтому пишем его
 * только вместе с нашей моделью и чужой дефолт им не задеваем.
 * Свой каталог моделей (`model_catalog_json`) не пишем: схема ModelInfo большая
 * и меняется от версии к версии; цена — предупреждение Codex «Model metadata …
 * not found» при старте, о нём говорим в сообщении.
 *
 * ── Модель по умолчанию ─────────────────────────────────────────────────────
 * Профилей в config.toml больше нет (с 0.134.0 — отдельные файлы), дефолт — это
 * пара верхнего уровня `model` + `model_provider`:
 *   явный --model                          → пишем всегда;
 *   нет ни `model`, ни `model_provider`    → файл ничего не выбирает, ставим себя;
 *   чужой провайдер либо `model` без провайдера (встроенный OpenAI) → не трогаем,
 *     печатаем разовую команду `codex -c model_provider=joingonka -m …`;
 *   наш провайдер и актуальная модель      → не трогаем (окно поправим, если его
 *     нет или оно больше реального);
 *   наш провайдер и ушедшая из сети модель → сбрасываем на дефолт.
 * `review_model` (модель команды /review, идёт к тому же провайдеру) чистим по
 * тому же правилу, когда провайдер уже был нашим; при переключении с чужого
 * провайдера — только предупреждаем.
 *
 * Путь один для обоих scope: проектный `.codex/config.toml` Codex читает, но
 * ключи `model_provider` и `model_providers` в нём игнорирует. Каталог:
 * непустой CODEX_HOME, иначе ~/.codex (home-dir/src/lib.rs; тильду Codex не
 * раскрывает).
 */
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_MODELS,
  modelLimits,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { nonEmptyString } from '../core/json-shape.js';
import { currentPathContext, envValue, pathApi, type PathContext } from '../core/paths.js';
import { staleRefsNote } from '../core/stale-refs.js';
import {
  applyTomlEdits,
  readTomlConfig,
  tomlTable,
  type TomlEdit,
  type TomlTable,
} from '../core/toml-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id нашего провайдера в `model_providers` (встроенные openai/ollama/lmstudio заняты). */
const CODEX_PROVIDER_ID = 'joingonka';

/** Имя провайдера. НЕ "OpenAI": по этому имени Codex включает серверное сжатие истории. */
const CODEX_PROVIDER_NAME = 'JoinGonka';

const PROVIDER_TABLE = ['model_providers', CODEX_PROVIDER_ID] as const;

/** Потолок окна у модели без встроенных метаданных (models-manager/src/model_info.rs). */
const CODEX_FALLBACK_MAX_CONTEXT = 272_000;

/** Права на файл — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Путь к config.toml. Окружение приходит параметром — чужая платформа
 * проверяется тестом на любой машине.
 */
export function codexConfigPath(ctx: PathContext = currentPathContext()): string {
  const { join, resolve } = pathApi(ctx);
  const custom = envValue(ctx, 'CODEX_HOME');
  return join(custom !== undefined ? resolve(custom) : join(ctx.home, '.codex'), 'config.toml');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function resolvePath(_scope: Scope): string {
  return codexConfigPath();
}

const setRoot = (key: string, value: string | number): TomlEdit => ({ op: 'set', table: [], key, value });

interface DefaultPlan {
  edits: TomlEdit[];
  lines: string[];
  /** Модель, которая после установки стоит у НАШЕГО провайдера (для review_model). */
  effectiveModel: string;
  /** Дефолт после установки — наш. */
  ours: boolean;
  /** Что было у пользователя и оказалось переключено; undefined — переключать было нечего. */
  switchedFrom?: string;
  /** Файл ничего не выбирал: до установки действовал встроенный провайдер OpenAI. */
  fromBuiltIn?: boolean;
  /** Сколько ссылок на ушедшие модели вычищено. */
  staleRefs: number;
}

/** Решение по дефолтной модели (правила — в шапке файла). */
function planDefault(root: TomlTable, input: ApplyInput): DefaultPlan {
  const provider = nonEmptyString(root.model_provider);
  const model = nonEmptyString(root.model);
  const wasOurs = provider === CODEX_PROVIDER_ID;
  const live = wasOurs && model !== undefined && CANONICAL_IDS.includes(model);

  const takeOver = (): DefaultPlan => {
    const { contextWindow } = modelLimits(input.model);
    // «Ушла из сети» говорим только про модель вне каталога: явная смена одной
    // живой модели на другую — обычное переключение.
    const retired =
      wasOurs && model !== undefined && model !== input.model && !CANONICAL_IDS.includes(model);
    const lines = [
      `Default model: ${input.model} (model_provider = "${CODEX_PROVIDER_ID}", ` +
        `model_context_window = ${contextWindow})` +
        (retired ? ` — replaces ${model}, which the Gonka network no longer serves` : ''),
    ];
    if (contextWindow > CODEX_FALLBACK_MAX_CONTEXT) {
      lines.push(
        `Note: Codex caps models it has no built-in metadata for at ${CODEX_FALLBACK_MAX_CONTEXT} tokens, ` +
          `so it compacts the history earlier than the real ${contextWindow}-token window requires.`,
      );
    }
    const previous = [
      !wasOurs && provider !== undefined ? `model_provider = "${provider}"` : undefined,
      !wasOurs && model !== undefined ? `model = "${model}"` : undefined,
    ].filter((part): part is string => part !== undefined);
    return {
      edits: [
        setRoot('model', input.model),
        setRoot('model_provider', CODEX_PROVIDER_ID),
        setRoot('model_context_window', contextWindow),
      ],
      lines,
      effectiveModel: input.model,
      ours: true,
      switchedFrom: previous.length > 0 ? previous.join(', ') : undefined,
      fromBuiltIn: provider === undefined && model === undefined,
      staleRefs: retired ? 1 : 0,
    };
  };

  if (input.modelExplicit) return takeOver();
  if (provider === undefined && model === undefined) return takeOver();

  if (!wasOurs) {
    const { contextWindow } = modelLimits(input.model);
    const current =
      provider !== undefined
        ? `model_provider = "${provider}"${model !== undefined ? `, model = "${model}"` : ''}`
        : `model = "${model}", built-in OpenAI provider`;
    return {
      edits: [],
      lines: [
        `Kept your default (${current}).`,
        '      Try JoinGonka for one session:',
        `        codex -c model_provider=${CODEX_PROVIDER_ID} -c model_context_window=${contextWindow} -m ${input.model}`,
        '      Make it the default: re-run with --model deepseek|glm|minimax',
      ],
      effectiveModel: input.model,
      ours: false,
      staleRefs: 0,
    };
  }

  if (!live) return takeOver();

  // Наша актуальная модель — выбор пользователя. Окно поправляем, только если его
  // нет или оно больше реального (слишком большое окно — всегда ошибка; меньшее —
  // осознанная настройка «сжимать раньше»).
  const { contextWindow } = modelLimits(model!);
  const window = root.model_context_window;
  const fixWindow = typeof window !== 'number' || window > contextWindow;
  return {
    edits: fixWindow ? [setRoot('model_context_window', contextWindow)] : [],
    lines: [
      `Kept your current default model: ${model}` +
        (fixWindow ? ` (model_context_window set to its real ${contextWindow} tokens)` : ''),
      '      Switch with --model deepseek|glm|minimax',
    ],
    effectiveModel: model!,
    ours: true,
    staleRefs: 0,
  };
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем и считаем итоговый текст ДО бэкапа: любой отказ оставляет диск
  // нетронутым (ни записи, ни лишнего .bak).
  const doc = readTomlConfig(readRaw(configPath), configPath);
  const provider = tomlTable(tomlTable(doc.value.model_providers)?.[CODEX_PROVIDER_ID]);
  const defaults = planDefault(doc.value, input);

  const setProvider = (key: string, value: string): TomlEdit => ({
    op: 'set',
    table: PROVIDER_TABLE,
    key,
    value,
  });
  const edits: TomlEdit[] = [
    ...defaults.edits,
    setProvider('name', CODEX_PROVIDER_NAME),
    setProvider('base_url', BASE_URL_OPENAI),
    setProvider('wire_api', 'responses'),
  ];

  // Командная авторизация и литеральный токен взаимоисключающие (validate).
  const commandAuth = provider?.auth !== undefined;
  const hadEnvKey = provider?.env_key !== undefined;
  if (!commandAuth) {
    edits.push(setProvider('experimental_bearer_token', input.apiKey));
    edits.push({ op: 'remove', table: PROVIDER_TABLE, key: 'env_key' });
  }

  // review_model идёт к тому же провайдеру, что и основная модель.
  const reviewModel = nonEmptyString(doc.value.review_model);
  const wasOurs = nonEmptyString(doc.value.model_provider) === CODEX_PROVIDER_ID;
  let staleRefs = defaults.staleRefs;
  const reviewLines: string[] = [];
  if (reviewModel !== undefined && reviewModel !== defaults.effectiveModel && !CANONICAL_IDS.includes(reviewModel)) {
    if (wasOurs) {
      edits.push(setRoot('review_model', defaults.effectiveModel));
      staleRefs += 1;
    } else if (defaults.ours) {
      reviewLines.push(
        `Note: review_model = "${reviewModel}" is still set, and /review sends it to the default ` +
          'provider — now JoinGonka. Remove that line or set it to a JoinGonka model.',
      );
    }
  }

  const text = applyTomlEdits(doc.text, edits, configPath);

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  const staleNote = staleRefsNote(staleRefs);
  const messages = [
    `Configured provider "${CODEX_PROVIDER_ID}" in ${configPath}`,
    `Base URL: ${BASE_URL_OPENAI} (Responses API — the only wire protocol Codex supports)`,
    ...defaults.lines,
    ...(staleNote ? [staleNote] : []),
    ...reviewLines,
  ];

  if (defaults.switchedFrom !== undefined) {
    messages.push(
      `Switched Codex to JoinGonka — this replaced your previous ${defaults.switchedFrom}.`,
      `To go back: ${backupPath != null ? `restore ${backupPath}, or ` : ''}put those values back into ` +
        'config.toml (no model_provider line means the built-in OpenAI provider).',
    );
  } else if (defaults.fromBuiltIn) {
    // Большинство пользователей Codex входят через ChatGPT и провайдера в файле не
    // выбирают — молча увести их дефолт нельзя, говорим, как вернуть.
    messages.push(
      'Codex now starts with JoinGonka by default (the file selected no provider before, so the',
      'built-in OpenAI one applied). To return to it: delete the model, model_provider and',
      'model_context_window lines from config.toml.',
    );
  }

  messages.push('');
  if (commandAuth) {
    messages.push(
      `This provider fetches its token with your [${PROVIDER_TABLE.join('.')}.auth] command (Codex rejects`,
      'auth together with a literal token), so the API key was NOT stored and auth was left as is.',
    );
  } else {
    messages.push(
      `Your API key was written into [${PROVIDER_TABLE.join('.')}] as experimental_bearer_token`,
      '(file mode 0600) — the only Codex setting that holds a key literally. Your shell',
      'environment was not changed. Codex calls the field experimental: if a future version',
      'renames it, requests fail with 401 — re-run this installer then.',
    );
    if (hadEnvKey) {
      messages.push(
        'Removed env_key from that table: Codex reads it first, so it would either shadow the key',
        'above or fail on a missing environment variable.',
      );
    }
  }

  if (defaults.ours) {
    messages.push(
      '',
      'Expect a warning at start-up — "Model metadata for ... not found. Defaulting to fallback',
      'metadata": Codex ships metadata only for OpenAI models. The context window set above is the',
      'part of it that matters.',
    );
  }
  messages.push(
    '',
    'The Codex IDE extension reads the same config.toml. A project-level .codex/config.toml cannot',
    'select a provider (Codex ignores model_provider there), so this is a user-level setting.',
  );

  return { configPath, backupPath, wrote: true, messages };
}

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex CLI (OpenAI Responses-compatible)',
  format: 'toml',
  // Codex ходит в /v1/responses — live-проверка идёт тем же маршрутом (до второй
  // части 0.5.0 она шла через /v1/chat/completions и подтверждала не его протокол).
  apiMode: 'responses',
  // Кодовый агент, которому установщик ПИШЕТ модель: по умолчанию DeepSeek V4 Flash.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
