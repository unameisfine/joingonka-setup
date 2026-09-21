/**
 * Адаптер omp (Oh My Pi, https://github.com/can1357/oh-my-pi) — YAML, два файла.
 *
 * omp — форк Pi, но конфиги у него свои: YAML вместо JSON и другой каталог.
 *   1) ~/.omp/agent/models.yml — каталог провайдеров:
 *        providers.<id> = { baseUrl, api, apiKey, models: [ {id, name, input,
 *                           contextWindow, maxTokens, cost, [reasoning]} ] }
 *   2) ~/.omp/agent/config.yml — настройки; модель по умолчанию живёт в
 *        modelRoles.default = "<provider>/<modelId>"
 *
 * ★ Первоисточник (сверено 21.09.2026, omp 18.2.8, коммит 260eaa35):
 *   - https://github.com/can1357/oh-my-pi/blob/main/docs/models.md — форма
 *     models.yml, допустимые `api`, порядок разрешения ключа;
 *   - https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md и
 *     docs/config-usage.md — config.yml, modelRoles, миграции, PI_CODING_AGENT_DIR;
 *   - README, раздел «Custom OpenAI-compatible providers» — ровно наш случай;
 *   - исходники: packages/coding-agent/src/config/models-config-schema-bundle.ts
 *     (схема), resolve-config-value.ts (значение apiKey), config-file.ts
 *     (models.yaml и перенос models.json), settings.ts (перенос settings.json),
 *     model-resolver.ts (разбор селектора), packages/utils/src/dirs.ts (пути).
 *
 * Что прописываем (провайдер `joingonka`, OpenAI-режим):
 *   baseUrl = BASE_URL_OPENAI (С /v1 — omp дописывает /chat/completions);
 *   api     = "openai-completions" (наш зрелый роут; ещё бывают openai-responses,
 *             anthropic-messages и др. — docs/models.md);
 *   apiKey  = ЛИТЕРАЛЬНЫЙ jg-... (файл 0o600).
 *
 * Ключ ЛИТЕРАЛОМ: omp трактует apiKey как «имя env-переменной, а если такой нет —
 * литерал» (resolve-config-value.ts), значение с `!` — как команду. Ключ `jg-…`
 * не может совпасть с именем переменной окружения (дефис) и не начинается с `!`,
 * поэтому читается как есть. Env-ссылку не пишем: установщик её не персистит.
 *
 * Селектор модели режется по ПЕРВОМУ `/` (model-resolver.ts), поэтому id вида
 * `deepseek-ai/DeepSeek-V4-Flash-0731` в `joingonka/<id>` законен. У значения роли
 * бывает хвост уровня размышлений (`:high`) — учитываем его, когда решаем,
 * устарела ли наша модель.
 *
 * ★ Схема models.yml строгая: неизвестный корневой ключ или лишнее поле модели —
 * и omp отвергает ВЕСЬ файл (работает на встроенных моделях, наш провайдер
 * пропадает). Поэтому пишем только подтверждённые поля, а запись модели берём из
 * общего piModelEntry (её набор полей входит в ModelDefinitionSchema omp; гейт
 * расхождения — тест в omp.test.ts).
 *
 * ★ Две наследные миграции omp, которые нельзя сорвать (обе срабатывают, только
 * пока YAML-файла НЕТ):
 *   - models.json → models.yml: если yml нет, а json есть, стартуем с содержимого
 *     json (то же, что сделал бы сам omp), иначе чужие провайдеры молча исчезнут;
 *   - settings.json → config.yml: рядом с settings.json config.yml НЕ создаём —
 *     печатаем, как выбрать модель после первого запуска omp.
 *
 * Путь один для обоих scope: каталог провайдеров у omp только пользовательский
 * (проектный .omp/config.yml умеет роли, но не провайдеров и не ключи).
 * Каталог агента: именованный профиль (OMP_PROFILE, наследный PI_PROFILE) →
 * ~/.omp/profiles/<имя>/agent; иначе PI_CODING_AGENT_DIR; иначе
 * ~/<PI_CONFIG_DIR|.omp>/agent. XDG-переезд omp на конфиги не распространяется.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { Document, isMap, isScalar, isSeq } from 'yaml';
import {
  BASE_URL_OPENAI,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_MODELS,
  piModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig } from '../core/json-config.js';
import { priceFor } from '../core/pricing.js';
import { staleRefsNote } from '../core/stale-refs.js';
import { ensureMapAt, loadYamlMap, renderYaml } from '../core/yaml-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Id нашего провайдера в `providers` файла models.yml. */
const OMP_PROVIDER_ID = 'joingonka';

/** Транспорт провайдера: /v1/chat/completions (docs/models.md, «Allowed api values»). */
const OMP_PROVIDER_API = 'openai-completions';

/** Права на models.yml — только владелец (rw-------): внутри литеральный ключ. */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — для сброса устаревшего дефолта. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/** Хвост уровня размышлений у селектора роли (docs/models.md, «CLI and pattern parsing»). */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Правила имени профиля — как в packages/utils/src/dirs.ts (normalizeProfileName). */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Активный профиль omp: OMP_PROFILE, если он ЗАДАН (даже пустым — тогда профиль
 * по умолчанию), иначе наследный PI_PROFILE. `default`/пусто → undefined.
 * Некорректное имя — отказ: omp с таким именем не стартует, а мы записали бы
 * конфиг в каталог, который он никогда не прочитает.
 */
function activeProfile(): string | undefined {
  const raw = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
  const name = raw?.trim();
  if (!name || name === 'default') return undefined;
  if (name.endsWith('.') || !PROFILE_NAME_RE.test(name) || WINDOWS_RESERVED_RE.test(name)) {
    throw new Error(
      `Invalid omp profile "${raw}" (OMP_PROFILE / PI_PROFILE). Nothing was written — ` +
        `fix the variable and run the installer again.`,
    );
  }
  return name;
}

/** Каталог агента omp; homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function agentDir(): string {
  const root = join(homedir(), process.env.PI_CONFIG_DIR || '.omp');
  const profile = activeProfile();
  if (profile) {
    // Именованный профиль PI_CODING_AGENT_DIR игнорирует (docs/config-usage.md).
    return join(root, 'profiles', profile, 'agent');
  }
  const override = process.env.PI_CODING_AGENT_DIR;
  if (typeof override === 'string' && override.trim() !== '') {
    return resolve(override.trim());
  }
  return join(root, 'agent');
}

/**
 * Файл из пары `<имя>.yml` / `<имя>.yaml`: omp читает первый существующий, а
 * существующий .yaml обновляет на месте. Нет ни одного — канонический .yml.
 */
function yamlPair(dir: string, name: string): string {
  const yml = join(dir, `${name}.yml`);
  const yaml = join(dir, `${name}.yaml`);
  return !existsSync(yml) && existsSync(yaml) ? yaml : yml;
}

/** Основной конфиг адаптера — каталог провайдеров. */
function resolvePath(_scope: Scope): string {
  return yamlPair(agentDir(), 'models');
}

/** Правки models.yml: наш провайдер; каталог моделей — целиком актуальным набором. */
function editModels(doc: Document, filePath: string, input: ApplyInput): void {
  ensureMapAt(doc, ['providers'], filePath);
  // providers.joingonka — НАШ ключ: мусор на его месте заменяем, а не отказываем.
  ensureMapAt(doc, ['providers', OMP_PROVIDER_ID], filePath, true);

  const provider = ['providers', OMP_PROVIDER_ID];
  doc.setIn([...provider, 'baseUrl'], BASE_URL_OPENAI);
  doc.setIn([...provider, 'api'], OMP_PROVIDER_API);
  // Литеральный ключ jg-... (НЕ имя env-переменной и НЕ !команда). Файл 0o600.
  doc.setIn([...provider, 'apiKey'], input.apiKey);
  // Каталог пересобираем целиком: ушедшие из сети модели исчезают. contextWindow
  // и maxTokens задаём явно — без них omp подставит свои значения по умолчанию.
  // `cost` ($ за 1M токенов, как в примерах docs/models.md) — живая цена на момент
  // установки (input.pricing), иначе константа-фолбэк; у omp это плоская цена,
  // по которой он считает стоимость сессии.
  const models = OPENCLAW_MODELS.map((spec) => piModelEntry(spec, priceFor(input.pricing, spec.id)));
  doc.setIn([...provider, 'models'], doc.createNode(models));
}

/** Селектор указывает на НАШ провайдер (хвост уровня размышлений не мешает). */
function isOurs(selector: unknown): selector is string {
  return typeof selector === 'string' && selector.startsWith(`${OMP_PROVIDER_ID}/`);
}

/** Наш селектор, модели которого в каталоге больше нет (чужие и актуальные — false). */
function isOurStale(selector: unknown): selector is string {
  if (!isOurs(selector)) return false;
  const modelId = selector.slice(OMP_PROVIDER_ID.length + 1).replace(THINKING_SUFFIX, '');
  return !CANONICAL_IDS.includes(modelId);
}

/** Что делать с modelRoles.default. */
type DefaultDecision =
  | { action: 'write'; ref: string }
  | { action: 'keep'; current: string; ours: boolean };

/**
 * Правило п.5 канона: явная модель пишется всегда; иначе дефолт ставим, только
 * если он пуст или указывает на НАШУ модель, которой больше нет в каталоге.
 */
function decideDefault(current: unknown, input: ApplyInput): DefaultDecision {
  const ref = `${OMP_PROVIDER_ID}/${input.model}`;
  if (input.modelExplicit || typeof current !== 'string' || current.trim() === '') {
    return { action: 'write', ref };
  }
  if (isOurStale(current)) {
    return { action: 'write', ref };
  }
  return { action: 'keep', current, ours: isOurs(current) };
}

/**
 * Наши убранные модели ВНЕ modelRoles.default (принцип — core/stale-refs.ts):
 *   - остальные роли (plan, smol, slow, …) → модель этой установки: роль человек
 *     осознанно отдал нашему провайдеру, так и должно остаться. Хвост уровня
 *     размышлений не переносим — он подбирался под прежнюю модель;
 *   - retry.fallbackChains.<ключ> → запись выбрасываем (замена дала бы дубли).
 *     Саму цепочку не удаляем даже пустой: `[]` у omp значит «без запасных», а
 *     удалённый ключ вернул бы роли встроенную цепочку (docs/settings.md).
 * Формат сверен 21.09.2026 по docs/settings.md, раздел «Models».
 * Возвращает число вычищенных ссылок.
 */
function cleanStaleRefs(doc: Document, replacement: string): number {
  let cleaned = 0;

  const roles = doc.getIn(['modelRoles'], true);
  if (isMap(roles)) {
    for (const pair of roles.items) {
      const role = isScalar(pair.key) ? pair.key.value : pair.key;
      if (role === 'default' || typeof role !== 'string') continue;
      if (isOurStale(roles.get(role))) {
        roles.set(role, replacement);
        cleaned += 1;
      }
    }
  }

  const chains = doc.getIn(['retry', 'fallbackChains'], true);
  if (isMap(chains)) {
    for (const pair of chains.items) {
      const chain = pair.value;
      if (!isSeq(chain)) continue;
      for (let i = chain.items.length - 1; i >= 0; i -= 1) {
        if (isOurStale(chain.get(i))) {
          chain.delete(i);
          cleaned += 1;
        }
      }
    }
  }

  return cleaned;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const dir = agentDir();

  // 1) models.yml. Читаем ДО любых записей: неразбираемый файл = отказ целиком.
  const modelsFile = yamlPair(dir, 'models');
  const modelsRaw = readRaw(modelsFile);
  const notes: string[] = [];
  let modelsDoc: Document;
  const legacyModels = join(dir, 'models.json');
  if (modelsRaw == null && existsSync(legacyModels)) {
    // Перенос, который сделал бы сам omp при старте (config-file.ts, migrateJsonToYml).
    modelsDoc = new Document(readJsonConfig(readRaw(legacyModels), legacyModels).value);
    notes.push(
      `Seeded ${modelsFile} from your legacy models.json (left in place), so its`,
      'providers stay visible to omp.',
    );
  } else {
    modelsDoc = loadYamlMap(modelsRaw, modelsFile);
  }
  editModels(modelsDoc, modelsFile, input);

  // 2) config.yml — тоже читаем заранее: omp с битым config.yml не стартует вовсе.
  const configFile = yamlPair(dir, 'config');
  const configRaw = readRaw(configFile);
  const configDoc = loadYamlMap(configRaw, configFile);
  ensureMapAt(configDoc, ['modelRoles'], configFile);
  const currentDefault = configDoc.getIn(['modelRoles', 'default']);
  const decision = decideDefault(currentDefault, input);
  // Чистка остальных ссылок идёт всегда — даже когда дефолт чужой и остаётся как был.
  const staleRefs =
    cleanStaleRefs(configDoc, `${OMP_PROVIDER_ID}/${input.model}`) + (isOurStale(currentDefault) ? 1 : 0);
  // Рядом с наследным settings.json config.yml не создаём: иначе omp не перенесёт
  // настройки (перенос идёт, только пока config.yml нет — settings.ts).
  const legacySettings = configRaw == null && existsSync(join(dir, 'settings.json'));

  // Оба текста готовим ДО первой записи: установка либо проходит целиком, либо
  // не трогает диск. config.yml пишем, только если значение действительно меняется.
  const modelsText = renderYaml(modelsDoc, modelsFile);
  let configChanged = staleRefs > 0;
  const defaultLines: string[] = [];
  if (decision.action === 'keep') {
    defaultLines.push(
      decision.ours
        ? `Kept your current default model (${decision.current}).`
        : `Kept your existing default model (${decision.current}).`,
      '      Switch with --model deepseek|glm|minimax, or inside omp: /model',
    );
  } else if (legacySettings) {
    defaultLines.push(
      `Default model NOT set: ${dir} has a legacy settings.json and no config.yml.`,
      '      omp migrates it on the next start, and creating config.yml now would skip that.',
      `      Start omp once, then re-run this installer — or pick ${decision.ref} with /model.`,
    );
  } else {
    if (currentDefault !== decision.ref) {
      configDoc.setIn(['modelRoles', 'default'], decision.ref);
      configChanged = true;
    }
    defaultLines.push(`Default model: ${decision.ref} (modelRoles.default in ${configFile})`);
  }
  const configText = configChanged ? renderYaml(configDoc, configFile) : null;
  const staleNote = staleRefsNote(staleRefs);
  if (staleNote) defaultLines.push(staleNote);

  // 3) Записи. Бэкап — только теперь, когда точно пишем.
  const backupPath = backup(modelsFile);
  await atomicWrite(modelsFile, modelsText, OWNER_ONLY_MODE);
  if (configText != null) {
    const configBackup = backup(configFile);
    // Секретов в config.yml нет — права существующего файла сохраняются.
    await atomicWrite(configFile, configText);
    if (configBackup != null) notes.push(`Previous ${configFile} backed up at ${configBackup}`);
  }

  return {
    configPath: modelsFile,
    backupPath,
    wrote: true,
    messages: [
      `Configured provider "${OMP_PROVIDER_ID}" in ${modelsFile}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      ...defaultLines,
      ...notes,
      '',
      // Ключ записан ЛИТЕРАЛЬНО (0o600). omp умеет и имя env-переменной, но её
      // пришлось бы экспортировать, а установщик окружение не трогает.
      'Your API key was written into the config (file mode 0o600, owner-only) — no',
      `environment variable needed. Restart omp, then check with: omp models ${OMP_PROVIDER_ID}`,
    ],
  };
}

export const ompAdapter: Adapter = {
  id: 'omp',
  label: 'omp / Oh My Pi (OpenAI-compatible)',
  format: 'yaml',
  apiMode: 'openai',
  // Кодовый агент: там, где установщик ПИШЕТ модель в конфиг, по умолчанию идёт
  // DeepSeek V4 Flash (380K/32768) — решение оператора 21.09.2026.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  // В записи модели есть `cost` — просим у оркестратора живые цены.
  wantsPricing: true,
  resolvePath,
  apply,
};
