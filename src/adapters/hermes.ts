/**
 * Адаптер Hermes — YAML-конфиг config.yaml в каталоге Hermes (~/.hermes, на
 * Windows — %LOCALAPPDATA%\hermes; Hermes Agent, Nous Research).
 *
 * Первый YAML-ПИШУЩИЙ адаптер пакета (у continue YAML только в печатных
 * инструкциях). Работаем через Document-API пакета `yaml` (parseDocument +
 * setIn), а не parse/stringify: точечные setIn не трогают чужие ключи
 * (mcp_servers, agent, compression, custom_providers, fallback_providers)
 * и сохраняют комментарии/форматирование пользователя.
 *
 * Что прописываем (кастомный OpenAI-совместимый endpoint):
 *   model:
 *     provider: custom
 *     model: <выбранная модель>            # reconcile: старое значение перезаписывается
 *     base_url: BASE_URL_OPENAI            # С /v1 — Hermes сам дописывает /chat/completions
 *     api_key: <литеральный ключ jg-...>
 *
 * ГЛАВНАЯ ГРАБЛЯ (проверено вручную 20.08.2026 на Hermes v0.20.4): документация
 * Hermes утверждает, что кастомный endpoint берёт OPENAI_API_KEY из
 * ~/.hermes/.env — это НЕВЕРНО: с ключом в .env gateway отдаёт HTTP 401
 * (тот же ключ прямым curl — 200). Ключ читается ТОЛЬКО из model.api_key
 * (исходник Hermes, hermes_cli/config.py:1079: «model.api_key is valid only
 * for explicit custom endpoint assignments»). Ложится на наш канон: ключ
 * ЛИТЕРАЛОМ в конфиг 0o600, никаких env-ссылок (см. openclaw.ts — та же
 * история с ${GONKA_API_KEY}).
 *
 * Фолбэки в Hermes opt-in: блок fallback_providers НЕ создаём — без него
 * работает только primary. Существующий пользовательский блок не трогаем —
 * кроме записей на НАШ шлюз с моделью, которой в сети больше нет (см.
 * pruneStaleFallbacks): такая запись мертва, а Hermes на 404 от неё просто
 * идёт дальше по цепочке.
 *
 * Путь один для обоих scope: Hermes читает глобальный конфиг — см. hermesConfigPath.
 */
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { BASE_URL, BASE_URL_OPENAI, DEEPSEEK_MODEL, OPENCLAW_MODELS } from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import {
  currentPathContext,
  envValue,
  expandTilde,
  pathApi,
  type PathContext,
} from '../core/paths.js';
import { staleRefsNote } from '../core/stale-refs.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/** Актуальные id моделей каталога — чтобы узнать запасную на убранную модель. */
const CANONICAL_IDS = OPENCLAW_MODELS.map((m) => m.id);

/**
 * Путь к config.yaml. Сверено 21.09.2026 по исходнику Hermes
 * (hermes_constants.py::_get_platform_default_hermes_home и get_hermes_home) и
 * доке https://hermes-agent.nousresearch.com/docs/user-guide/windows-native:
 *   1. HERMES_HOME — КАТАЛОГ (не путь к файлу), тильда в нём раскрывается
 *      (os.path.expanduser) → <HERMES_HOME>/config.yaml;
 *   2. Windows: %LOCALAPPDATA%\hermes (нет переменной — ~\AppData\Local\hermes);
 *      установщик Hermes сам задаёт там HERMES_HOME, но полагаться на это нельзя:
 *      переменная пользователя видна только новым терминалам;
 *   3. остальные платформы: ~/.hermes.
 * До 0.4.5 пункта 2 не было: на Windows конфиг уходил в ~/.hermes, которого
 * нативный Hermes не читает.
 *
 * Окружение приходит параметром, чтобы Windows-ветку можно было проверить тестом.
 */
export function hermesConfigPath(ctx: PathContext = currentPathContext()): string {
  const { join } = pathApi(ctx);
  const fromEnv = envValue(ctx, 'HERMES_HOME');
  if (fromEnv) {
    return join(expandTilde(fromEnv, ctx), 'config.yaml');
  }
  if (ctx.platform === 'win32') {
    const local = envValue(ctx, 'LOCALAPPDATA') ?? join(ctx.home, 'AppData', 'Local');
    return join(local, 'hermes', 'config.yaml');
  }
  return join(ctx.home, '.hermes', 'config.yaml');
}

/** Окружение читается В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env). */
function resolvePath(_scope: Scope): string {
  return hermesConfigPath();
}

/** Что делать пользователю, когда его файл нельзя править безопасно. */
const REFUSAL_HINT =
  'Nothing was written — fix the file (or move it aside) and run the installer again.';

/**
 * Загружает существующий config.yaml как YAML-Document. Файла нет, он пуст
 * или в нём одни комментарии → новый документ (комментарии сохраняются).
 *
 * ★ Битый YAML и корень-не-map (скаляр/список) → ОТКАЗ, как у JSON-адаптеров
 * (core/json-config): вызывающий к этому моменту ничего не записал и бэкапа не
 * делал. До 0.4.5 здесь молча возвращался пустой документ, и config.yaml
 * перезаписывался: человек терял mcp_servers, память, расписания — всё, что в
 * нём жило, — из-за одной незакрытой скобки.
 */
function loadDocument(raw: string | null, filePath: string): Document {
  if (raw == null || raw.trim() === '') {
    return new Document({});
  }
  const doc = parseDocument(raw);
  const first = doc.errors[0];
  if (first) {
    // Первая строка сообщения уже содержит «at line N, column M»; дальше в нём
    // идёт многострочная выдержка из файла — в ошибку её не тащим.
    const reason = first.message.split('\n')[0]!.replace(/:$/, '');
    throw new Error(`${filePath} is not valid YAML: ${reason}. ${REFUSAL_HINT}`);
  }
  if (doc.contents != null && !isMap(doc.contents)) {
    throw new Error(`${filePath} does not contain a YAML mapping at the top level. ${REFUSAL_HINT}`);
  }
  return doc;
}

/** true — запись запасной модели ведёт на НАШ шлюз, а модели в сети уже нет. */
function isStaleFallback(entry: unknown): entry is YAMLMap {
  if (!isMap(entry)) return false;
  const baseUrl = entry.get('base_url');
  const model = entry.get('model');
  return (
    typeof baseUrl === 'string' &&
    baseUrl.trim().startsWith(BASE_URL) &&
    typeof model === 'string' &&
    !CANONICAL_IDS.includes(model.trim())
  );
}

/**
 * Выбрасывает из цепочки запасных записи на наш шлюз с убранной моделью.
 *
 * Формат сверен 21.09.2026 по hermes_cli/fallback_config.py (get_fallback_chain,
 * _iter_fallback_entries) и доке …/docs/user-guide/features/fallback-providers:
 * `fallback_providers` — текущий ключ, `fallback_model` — прежний; значение —
 * список записей { provider, model, base_url?, api_key? | key_env? } либо одна
 * такая запись-словарь. Кастомный endpoint опознаётся по `base_url` — только
 * такие записи мы и можем уверенно назвать своими; запись, ссылающуюся на
 * именованного провайдера без base_url, не трогаем.
 *
 * Возвращает число выброшенных записей. Опустевший ключ удаляется целиком.
 */
function pruneStaleFallbacks(doc: Document): number {
  let removed = 0;
  for (const key of ['fallback_providers', 'fallback_model']) {
    const node = doc.get(key, true);
    if (isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i -= 1) {
        if (isStaleFallback(node.items[i])) {
          node.delete(i);
          removed += 1;
        }
      }
      if (node.items.length === 0) doc.delete(key);
    } else if (isStaleFallback(node)) {
      doc.delete(key);
      removed += 1;
    }
  }
  return removed;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Порядок: прочитать → посчитать итоговый текст → и только потом бэкап и
  // запись. Файл, который нельзя разобрать, приводит к отказу, и тогда мы не
  // трогаем диск вовсе (ни записи, ни лишнего .bak); то же — если правка
  // документа бросит исключение на неожиданной форме узла.
  const doc = loadDocument(readRaw(configPath), configPath);

  // `model` может оказаться скаляром/списком (рукописный конфиг) — setIn в него
  // бросил бы исключение; убираем узел, setIn ниже создаст map заново.
  const modelNode = doc.getIn(['model']);
  if (modelNode !== undefined && !isMap(modelNode)) {
    doc.deleteIn(['model']);
  }

  // Точечные setIn: наши ключи перезаписываются (reconcile — устаревшая
  // модель/URL/ключ не переживают повторную установку), чужие поля внутри
  // model (temperature и т.п.) и все прочие ключи конфига остаются как были.
  doc.setIn(['model', 'provider'], 'custom');
  // ★ Модель пишем в model.default — это КАНОНИЧЕСКИЙ ключ Hermes.
  // Проверено по исходнику (hermes_cli/config.py, _normalize_model_config):
  // приоритет `default` > `model` > `name`, причём явный `default` НИКОГДА не
  // перекрывается псевдонимами. До 0.4.5 мы писали только `model.model`, и на
  // любой уже настроенной установке (мастер Hermes задаёт `default`) наша
  // модель молча игнорировалась — агент продолжал ходить со старой, в том
  // числе с выведенной из сети.
  doc.setIn(['model', 'default'], input.model);
  // `model` дублируем для старых сборок Hermes, которые знают только его;
  // современные при первом же сохранении схлопнут псевдоним в `default`.
  doc.setIn(['model', 'model'], input.model);
  // `name` — третий псевдоним той же модели: оставленный, он переживёт наш
  // `default` только в старых сборках, поэтому убираем.
  doc.deleteIn(['model', 'name']);
  doc.setIn(['model', 'base_url'], BASE_URL_OPENAI);
  // Устаревшие способы передать ключ: если они остались от прошлых версий
  // установщика или от мастера Hermes, ключ может читаться из окружения, а не
  // из конфига. Сам Hermes чистит их тем же способом.
  for (const stale of ['api_mode', 'key_env', 'api_key_env']) {
    doc.deleteIn(['model', stale]);
  }
  // api_key = ЛИТЕРАЛЬНЫЙ ключ jg-... — НЕ env-ссылка и НЕ ~/.hermes/.env:
  // custom endpoint читает ключ только из model.api_key (config.py:1079),
  // с OPENAI_API_KEY в .env gateway отдаёт 401. Файл пишется 0o600.
  doc.setIn(['model', 'api_key'], input.apiKey);

  const staleNote = staleRefsNote(pruneStaleFallbacks(doc));
  const text = doc.toString();

  const backupPath = backup(configPath);
  await atomicWrite(configPath, text, OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Model: ${input.model}`,
      ...(staleNote ? [staleNote] : []),
      '',
      // Ключ ЛИТЕРАЛЬНО в model.api_key (0o600). Никаких .env: для custom
      // endpoints Hermes читает ключ только из model.api_key — OPENAI_API_KEY
      // в ~/.hermes/.env даёт HTTP 401 вопреки документации Hermes.
      'Your API key was written into config.yaml as model.api_key (file mode 0o600,',
      'owner-only). Do NOT put it into ~/.hermes/.env: custom endpoints read the key',
      'only from model.api_key, so an OPENAI_API_KEY there yields HTTP 401.',
      'Restart Hermes to pick up the provider; check with: hermes config show',
    ],
  };
}

export const hermesAdapter: Adapter = {
  id: 'hermes',
  label: 'Hermes (OpenAI-compatible)',
  format: 'yaml',
  // Hermes — автономный агент: длинная история tool-calling, память, планировщик.
  // Ему нужнее контекст и потолок ответа, чем универсальность DEFAULT_MODEL:
  // DeepSeek V4 Flash даёт 380K и 32768 против 200K и 8192 у остальных моделей сети.
  defaultModel: DEEPSEEK_MODEL,
  resolvePath,
  apply,
};
