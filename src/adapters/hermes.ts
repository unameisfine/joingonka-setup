/**
 * Адаптер Hermes — YAML-конфиг ~/.hermes/config.yaml (Hermes Agent, Nous Research).
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
 * работает только primary. Существующий пользовательский блок не трогаем
 * (на всякий случай у пользователя есть `hermes fallback clear`).
 *
 * Путь один для обоих scope: Hermes читает глобальный конфиг. Env HERMES_HOME
 * (КАТАЛОГ, не путь к файлу) переопределяет ~/.hermes.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Document, isMap, parseDocument } from 'yaml';
import { BASE_URL_OPENAI, DEEPSEEK_MODEL } from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Права на файл конфига — только владелец (rw-------). */
const OWNER_ONLY_MODE = 0o600;

/**
 * Разрешение пути:
 *   1. env HERMES_HOME (trim, непустой) — каталог Hermes → <HERMES_HOME>/config.yaml;
 *   2. иначе ~/.hermes/config.yaml.
 * homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env).
 */
function resolvePath(_scope: Scope): string {
  const fromEnv = process.env.HERMES_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return join(fromEnv.trim(), 'config.yaml');
  }
  return join(homedir(), '.hermes', 'config.yaml');
}

/**
 * Загружает существующий config.yaml как YAML-Document.
 *
 * Битый YAML или корень-не-map (скаляр/список) → свежий пустой документ:
 * setIn в такой корень бросил бы исключение, а бэкап к этому моменту уже
 * сделан — пользователь ничего не теряет.
 */
function loadDocument(raw: string | null): Document {
  if (raw == null) {
    return new Document({});
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0 || (doc.contents != null && !isMap(doc.contents))) {
    return new Document({});
  }
  return doc;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем существующее (если есть) и бэкапим ВСЕГДА при наличии файла —
  // даже если YAML битый, чтобы пользователь не потерял данные безвозвратно.
  const raw = readRaw(configPath);
  const backupPath = backup(configPath);

  const doc = loadDocument(raw);

  // `model` может оказаться скаляром/списком (рукописный конфиг) — setIn в него
  // бросил бы исключение; убираем узел, setIn ниже создаст map заново.
  const modelNode = doc.getIn(['model']);
  if (modelNode !== undefined && !isMap(modelNode)) {
    doc.deleteIn(['model']);
  }

  // Точечные setIn: наши 4 ключа перезаписываются (reconcile — устаревшая
  // модель/URL/ключ не переживают повторную установку), чужие поля внутри
  // model (temperature и т.п.) и все прочие ключи конфига остаются как были.
  doc.setIn(['model', 'provider'], 'custom');
  doc.setIn(['model', 'model'], input.model);
  doc.setIn(['model', 'base_url'], BASE_URL_OPENAI);
  // api_key = ЛИТЕРАЛЬНЫЙ ключ jg-... — НЕ env-ссылка и НЕ ~/.hermes/.env:
  // custom endpoint читает ключ только из model.api_key (config.py:1079),
  // с OPENAI_API_KEY в .env gateway отдаёт 401. Файл пишется 0o600.
  doc.setIn(['model', 'api_key'], input.apiKey);

  await atomicWrite(configPath, doc.toString(), OWNER_ONLY_MODE);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL_OPENAI}`,
      `Model: ${input.model}`,
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
