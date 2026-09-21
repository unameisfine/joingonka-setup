/**
 * Адаптер Goose (https://github.com/aaif-goose/goose, ранее block/goose) — до трёх
 * файлов в каталоге конфигов Goose.
 *
 *   1) custom_providers/custom_joingonka.json — декларативный провайдер:
 *        { name, engine, display_name, description, api_key_env, base_url,
 *          models: [ {name, context_limit} ], supports_streaming, requires_auth }
 *   2) secrets.yaml — плоский map «ИМЯ_СЕКРЕТА: значение», файловое хранилище
 *      секретов Goose (пишем не всегда — см. «Ключ» ниже);
 *   3) config.yaml — провайдер и модель по умолчанию.
 *
 * ★ Первоисточник (сверено 21.09.2026, goose 1.51.0, коммит 155c73e4):
 *   - https://goose-docs.ai/docs/getting-started/providers/ — раздел «Configure
 *     Custom Provider»: каталог, пример JSON, куда кладётся ключ;
 *   - https://goose-docs.ai/docs/guides/config-files — config.yaml
 *     (active_provider / providers), secrets.yaml, предупреждение «Provider API
 *     keys do not go in config.yaml»;
 *   - https://goose-docs.ai/docs/guides/environment-variables — GOOSE_DISABLE_KEYRING;
 *   - исходники: crates/goose-providers/src/declarative.rs (DeclarativeProviderConfig,
 *     validate_auth, строгий serde_json), crates/goose-providers/src/openai.rs
 *     (derive_base_path), crates/goose-provider-types/src/base.rs (ModelInfo),
 *     crates/goose/src/config/declarative_providers.rs (generate_id,
 *     generate_api_key_name), providers.rs (set_active_provider), migrations.rs
 *     (перенос плоских ключей), base.rs (порядок чтения секретов), paths.rs.
 *
 * ── Файл провайдера ──────────────────────────────────────────────────────────
 * Id `custom_joingonka` и имя секрета `CUSTOM_JOINGONKA_API_KEY` — ровно то, что
 * сам Goose выводит из имени «JoinGonka» (generate_id → `custom_` + slug;
 * generate_api_key_name → ВЕРХНИЙ_РЕГИСТР + `_API_KEY`). Поэтому ключ, введённый
 * потом через `goose configure` или Desktop, ляжет под то же имя.
 * base_url — ПОЛНЫЙ адрес …/v1/chat/completions, как в примере документации:
 * сборки до derive_base_path путь не достраивали и с голым /v1 получали 404.
 * У ModelInfo нет потолка выдачи — только context_limit; GOOSE_MAX_TOKENS
 * глобален для всех провайдеров, поэтому его не трогаем (шлюз сам ограничивает
 * выдачу пер-модельно).
 * Файл читается СТРОГИМ JSON (serde_json), причём один нечитаемый файл роняет
 * загрузку ВСЕХ custom_providers — комментарии в нём не «сохраняем», а отказываем.
 *
 * ── Ключ: почему не всегда литералом ────────────────────────────────────────
 * В JSON провайдера есть только ИМЯ секрета (api_key_env), поля для значения нет.
 * Значение Goose ищет так (base.rs, get_secret): переменная окружения → системный
 * keyring → secrets.yaml, но файл читается, только когда хранилище файловое:
 * keyring выключен (GOOSE_DISABLE_KEYRING в окружении либо в config.yaml),
 * недоступен (сервер, WSL, контейнер) или ещё пуст. Писать в keyring без нативной
 * зависимости мы не можем, а ВЫКЛЮЧИТЬ его за пользователя нельзя: Goose перестал
 * бы видеть все секреты, которые там уже лежат.
 *
 * Отсюда правило:
 *   - хранилище файловое по явному признаку (флаг выключения либо secrets.yaml уже
 *     существует — Goose создаёт его, только когда сам пишет секреты в файл) →
 *     кладём ключ ЛИТЕРАЛОМ в secrets.yaml, 0o600, чужие секреты целы;
 *   - иначе ключ НИКУДА не пишем и честно говорим, что остался один шаг:
 *     `goose configure` → Configure Providers → JoinGonka. Переменную окружения
 *     за пользователя не персистим (канон: глобальный env не трогаем);
 *   - у провайдера задан `auth` (ключ выдаёт команда) → api_key_env не ставим:
 *     оба поля сразу Goose отвергает (validate_auth).
 *
 * ── Модель по умолчанию ─────────────────────────────────────────────────────
 * У config.yaml две раскладки (providers.rs, migrations.rs):
 *   новая (с 05.2026): active_provider + providers.<id> = {enabled, model, configured};
 *   старая: плоские GOOSE_PROVIDER / GOOSE_MODEL.
 * Новый Goose читает обе (active_provider важнее) и переносит плоские ключи сам;
 * старый знает только плоские. Поэтому: есть блок providers или active_provider →
 * пишем как set_active_provider; иначе (старая раскладка или новый файл) — плоские
 * ключи, которые поймёт любая версия. Решение «писать или нет» — общее правило:
 * явная модель всегда; иначе только когда провайдера нет либо он наш, а модель
 * пуста или ушла из каталога.
 *
 * Путь один для обоих scope. Каталог конфигов (paths.rs, crate etcetera):
 * абсолютный GOOSE_PATH_ROOT → <root>/config; Windows → %APPDATA%\Block\goose\config;
 * иначе абсолютный XDG_CONFIG_HOME либо ~/.config, плюс `goose` (macOS — тоже XDG).
 */
import { chmodSync, statSync } from 'node:fs';
import type { Document } from 'yaml';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_CONTEXT_WINDOW,
} from '../constants.js';
import { catalogFor, catalogIds } from '../core/catalog.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import { nonEmptyString } from '../core/json-shape.js';
import { currentPathContext, envValue, pathApi, type PathContext } from '../core/paths.js';
import { ensureMapAt, loadYamlMap, renderYaml, YAML_REFUSAL_HINT } from '../core/yaml-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id провайдера = имя файла = то, что Goose сам строит из «JoinGonka» (generate_id). */
const GOOSE_PROVIDER_ID = 'custom_joingonka';

/** Имя в списках провайдеров (`goose configure`, Desktop). */
const GOOSE_DISPLAY_NAME = 'JoinGonka';

/** Имя секрета с ключом — как у generate_api_key_name(id). */
const GOOSE_API_KEY_NAME = `${GOOSE_PROVIDER_ID.toUpperCase()}_API_KEY`;

/** Полный адрес chat/completions — форма из примера документации. */
const GOOSE_BASE_URL = `${BASE_URL_OPENAI}/chat/completions`;

/** Права на файлы с секретом (и на файл провайдера, куда дописывают заголовки-токены). */
const OWNER_ONLY_MODE = 0o600;

/** Концовка отказа для файла провайдера (JSON) — та же, что у YAML-файлов. */
const NOTHING_WRITTEN = YAML_REFUSAL_HINT;

/**
 * Каталог конфигов Goose (см. шапку). Окружение приходит параметром — так ветка
 * Windows проверяется тестом на любой машине.
 */
export function gooseConfigDir(ctx: PathContext = currentPathContext()): string {
  const p = pathApi(ctx);
  const root = envValue(ctx, 'GOOSE_PATH_ROOT');
  if (root && p.isAbsolute(root)) {
    return p.join(root, 'config');
  }
  if (ctx.platform === 'win32') {
    const appData = envValue(ctx, 'APPDATA') ?? p.join(ctx.home, 'AppData', 'Roaming');
    // «Block» в пути Goose сохранил после переезда проекта — ради старых установок.
    return p.join(appData, 'Block', 'goose', 'config');
  }
  // etcetera принимает XDG_CONFIG_HOME, только если путь абсолютный.
  const xdg = envValue(ctx, 'XDG_CONFIG_HOME');
  return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(ctx.home, '.config'), 'goose');
}

/**
 * Как передать ключ Goose на ОДНУ сессию, не сохраняя его нигде. `ИМЯ=значение
 * команда` — синтаксис POSIX-оболочек; в PowerShell и cmd его нет, там переменная
 * задаётся отдельной командой и живёт до закрытия окна. Значение ключа не
 * повторяем. Окружение приходит параметром — Windows-ветка проверяется тестом.
 */
export function gooseInlineKeyHint(ctx: PathContext = currentPathContext()): string {
  return ctx.platform === 'win32'
    ? `For a single session you can set it in PowerShell instead: $env:${GOOSE_API_KEY_NAME} = "<your key>"; goose session`
    : `For a single session you can pass it inline instead: ${GOOSE_API_KEY_NAME}=<your key> goose session`;
}

/** Пути трёх файлов; окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function goosePaths(): { provider: string; config: string; secrets: string } {
  const ctx = currentPathContext();
  const p = pathApi(ctx);
  const dir = gooseConfigDir(ctx);
  return {
    provider: p.join(dir, 'custom_providers', `${GOOSE_PROVIDER_ID}.json`),
    config: p.join(dir, 'config.yaml'),
    secrets: p.join(dir, 'secrets.yaml'),
  };
}

function resolvePath(_scope: Scope): string {
  return goosePaths().provider;
}

/**
 * Файл провайдера: СТРОГИЙ JSON-объект (так его читает Goose). Нет файла или он
 * пуст → новый документ. Возвращает текст для точечных правок и разобранное значение.
 */
function loadProviderFile(raw: string | null, filePath: string): { text: string; value: Record<string, unknown> } {
  if (raw == null || raw.trim() === '') {
    return { text: '{}', value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${filePath} is not strict JSON — Goose reads provider files with a strict parser ` +
        `(no comments, no trailing commas). ${NOTHING_WRITTEN}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not contain a JSON object at the top level. ${NOTHING_WRITTEN}`);
  }
  return { text: raw, value: parsed as Record<string, unknown> };
}

/** setIn, который сообщает, изменилось ли значение (лишний раз файл не переписываем). */
function setIfChanged(doc: Document, path: string[], value: string | boolean): boolean {
  if (doc.getIn(path) === value) return false;
  doc.setIn(path, value);
  return true;
}

/** Точечные правки файла провайдера; каталог моделей — целиком актуальным набором. */
function providerEdits(commandAuth: boolean, input: ApplyInput): JsonEdit[] {
  // Модели сети плюс явно запрошенная модель вне каталога (core/catalog.ts): модель,
  // которой нет в списке провайдера, Goose не предложит и по умолчанию не возьмёт.
  const models = catalogFor(input).map((spec) => ({
    name: spec.id,
    context_limit: spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW,
  }));
  const edits: JsonEdit[] = [
    { path: ['name'], value: GOOSE_PROVIDER_ID },
    { path: ['engine'], value: 'openai' },
    { path: ['display_name'], value: GOOSE_DISPLAY_NAME },
    { path: ['description'], value: 'JoinGonka Gateway — Gonka AI inference (OpenAI-compatible)' },
  ];
  // api_key_env и auth взаимоисключающие (validate_auth): команду пользователя не ломаем.
  if (!commandAuth) edits.push({ path: ['api_key_env'], value: GOOSE_API_KEY_NAME });
  edits.push(
    { path: ['base_url'], value: GOOSE_BASE_URL },
    // Массив заменяем целиком, а не по индексам: ушедшие из сети модели исчезают.
    { path: ['models'], value: models },
    { path: ['supports_streaming'], value: true },
    { path: ['requires_auth'], value: true },
  );
  return edits;
}

/** Keyring выключен: переменная задана (значение любое — как у Goose) либо флаг в config.yaml. */
function keyringDisabled(configDoc: Document): boolean {
  if (process.env.GOOSE_DISABLE_KEYRING !== undefined) return true;
  const flag = configDoc.getIn(['GOOSE_DISABLE_KEYRING']);
  return flag === true || flag === 'true' || flag === '1';
}

/**
 * Модель по умолчанию в config.yaml. Возвращает, менялся ли документ, и строки
 * для пользователя.
 */
function editDefault(doc: Document, filePath: string, input: ApplyInput): { changed: boolean; lines: string[] } {
  // Раскладку определяем ДО правок: даже пустой `providers:` для Goose означает
  // новую раскладку (его миграция тогда вычищает плоские ключи).
  const structured = doc.has('providers') || doc.has('active_provider');
  ensureMapAt(doc, ['providers'], filePath);

  // Порядок чтения — как у Goose (providers.rs): active_provider, затем плоский ключ;
  // модель — из записи провайдера, затем плоский ключ.
  const provider = nonEmptyString(doc.getIn(['active_provider'])) ?? nonEmptyString(doc.getIn(['GOOSE_PROVIDER']));
  const model =
    (provider ? nonEmptyString(doc.getIn(['providers', provider, 'model'])) : undefined) ??
    nonEmptyString(doc.getIn(['GOOSE_MODEL']));

  if (!input.modelExplicit && provider) {
    if (provider !== GOOSE_PROVIDER_ID) {
      return {
        changed: false,
        lines: [
          `Kept your default provider (${provider}${model ? `, ${model}` : ''}).`,
          `      Try this one with: goose session --provider ${GOOSE_PROVIDER_ID} --model ${input.model}`,
        ],
      };
    }
    if (model && catalogIds(input).includes(model)) {
      return {
        changed: false,
        lines: [`Kept your current default model (${model}). Switch with --model deepseek|glm|minimax`],
      };
    }
  }

  let changed = false;
  if (structured) {
    // То же, что пишет set_active_provider: active_provider + {enabled, model, configured}.
    const entry = ['providers', GOOSE_PROVIDER_ID];
    ensureMapAt(doc, entry, filePath, true);
    changed = setIfChanged(doc, ['active_provider'], GOOSE_PROVIDER_ID) || changed;
    changed = setIfChanged(doc, [...entry, 'enabled'], true) || changed;
    changed = setIfChanged(doc, [...entry, 'model'], input.model) || changed;
    changed = setIfChanged(doc, [...entry, 'configured'], true) || changed;
  } else {
    changed = setIfChanged(doc, ['GOOSE_PROVIDER'], GOOSE_PROVIDER_ID) || changed;
    changed = setIfChanged(doc, ['GOOSE_MODEL'], input.model) || changed;
  }
  const lines = [`Default provider and model: ${GOOSE_PROVIDER_ID} / ${input.model} (${filePath})`];
  // Переменные окружения у Goose важнее config.yaml (guides/config-files): молча
  // записать дефолт, который не подействует, — тот же тихий обман, что и с --model.
  const written: Record<string, string> = { GOOSE_PROVIDER: GOOSE_PROVIDER_ID, GOOSE_MODEL: input.model };
  const envOverrides = Object.keys(written).filter(
    (name) => process.env[name] !== undefined && process.env[name] !== written[name],
  );
  if (envOverrides.length > 0) {
    lines.push(
      `Note: ${envOverrides.join(' and ')} in your environment override config.yaml — ` +
        'unset them for this default to take effect.',
    );
  }
  return { changed, lines };
}

/** Права «только владелец» на уже существующий файл (бэкап наследует права оригинала). */
function restrictToOwner(filePath: string | null): void {
  if (filePath == null || process.platform === 'win32') return;
  if ((statSync(filePath).mode & 0o077) !== 0) chmodSync(filePath, OWNER_ONLY_MODE);
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const paths = goosePaths();

  // 1) Читаем ВСЁ до первой записи: любой неразбираемый файл = отказ целиком.
  const providerDoc = loadProviderFile(readRaw(paths.provider), paths.provider);
  const configDoc = loadYamlMap(readRaw(paths.config), paths.config);
  const secretsRaw = readRaw(paths.secrets);
  const secretsDoc = loadYamlMap(secretsRaw, paths.secrets);

  // 2) Решения и тексты — тоже до записи.
  const commandAuth = typeof providerDoc.value.auth === 'object' && providerDoc.value.auth !== null;
  const explicitlyDisabled = keyringDisabled(configDoc);
  const fileStore = !commandAuth && (explicitlyDisabled || secretsRaw != null);

  const providerText = applyJsonEdits(
    providerDoc.text,
    providerEdits(commandAuth, input),
    paths.provider,
  );
  const defaults = editDefault(configDoc, paths.config, input);
  const configText = defaults.changed ? renderYaml(configDoc, paths.config) : null;
  const secretsText =
    fileStore && setIfChanged(secretsDoc, [GOOSE_API_KEY_NAME], input.apiKey)
      ? renderYaml(secretsDoc, paths.secrets)
      : null;

  // 3) Записи. Бэкап — только теперь и только тех файлов, которые меняем.
  const notes: string[] = [];
  const backupPath = backup(paths.provider);
  await atomicWrite(paths.provider, providerText, OWNER_ONLY_MODE);

  if (secretsText != null) {
    const secretsBackup = backup(paths.secrets);
    // В бэкапе — чужие секреты: открытым его не оставляем, даже если оригинал был открыт.
    restrictToOwner(secretsBackup);
    await atomicWrite(paths.secrets, secretsText, OWNER_ONLY_MODE);
    if (secretsBackup != null) notes.push(`Previous secrets.yaml backed up at ${secretsBackup}`);
  } else if (fileStore) {
    restrictToOwner(paths.secrets);
  }

  if (configText != null) {
    const configBackup = backup(paths.config);
    // Секретов в config.yaml нет — права существующего файла сохраняются.
    await atomicWrite(paths.config, configText);
    if (configBackup != null) notes.push(`Previous config.yaml backed up at ${configBackup}`);
  }

  // Как довести ключ до keyring. Значение ключа в сообщениях не повторяем.
  const storeInKeyring = [
    '    goose configure  →  Configure Providers  →  JoinGonka  →  paste your jg-... key',
    '    (Goose Desktop: Settings → Models → Configure providers → JoinGonka)',
  ];
  let keyLines: string[];
  if (commandAuth) {
    keyLines = [
      'This provider fetches its credential with your `auth` command (api_key_env and auth',
      'are mutually exclusive in Goose), so the API key was NOT stored and auth was left as is.',
    ];
  } else if (fileStore) {
    keyLines = [
      `Your API key was written into ${paths.secrets} as ${GOOSE_API_KEY_NAME}`,
      "(file mode 0o600, owner-only) — Goose's file-based secret store. No environment variable needed.",
    ];
    if (!explicitlyDisabled) {
      keyLines.push(
        `If Goose still reports "missing required key ${GOOSE_API_KEY_NAME}", its system keyring`,
        'took over secret storage — store the key there once:',
        ...storeInKeyring,
      );
    }
  } else {
    keyLines = [
      'ONE STEP LEFT — the API key. Goose keeps provider keys in the system keyring, which this',
      `installer cannot write, and its provider file holds only the secret's NAME (${GOOSE_API_KEY_NAME}).`,
      'Store the key once:',
      ...storeInKeyring,
      gooseInlineKeyHint(),
    ];
  }

  return {
    configPath: paths.provider,
    backupPath,
    wrote: true,
    messages: [
      `Configured provider "${GOOSE_PROVIDER_ID}" in ${paths.provider}`,
      `Base URL: ${GOOSE_BASE_URL}`,
      ...defaults.lines,
      ...notes,
      '',
      ...keyLines,
      '',
      'Restart Goose to pick up the provider; check the active settings with: goose info -v',
    ],
  };
}

export const gooseAdapter: Adapter = {
  id: 'goose',
  label: 'Goose (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  // Кодовый агент: там, где установщик ПИШЕТ модель в конфиг, по умолчанию идёт
  // DeepSeek V4 Flash (380K/32768) — решение оператора 21.09.2026.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
