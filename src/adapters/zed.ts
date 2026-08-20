/**
 * Адаптер Zed (https://zed.dev) — JSONC ~/.config/zed/settings.json.
 *
 * Zed принимает кастомный OpenAI-совместимый провайдер декларативно:
 *   language_models.openai_compatible.<id> = {
 *     api_url, available_models: [ {name, display_name, max_tokens,
 *                                   max_output_tokens, capabilities} ]
 *   }
 *
 * ★ КЛЮЧ В ЭТОТ ФАЙЛ НЕ ПИШЕТСЯ — единственный адаптер-исключение из канона
 * «литеральный ключ в конфиг». Док Zed прямо запрещает: «Do not put API keys
 * in settings.json»; поля для ключа в схеме нет вообще. Zed берёт ключ из
 * своего UI-хранилища (keychain) либо из env-переменной, имя которой выводит
 * из id провайдера: upper snake case + `_API_KEY` (`joingonka` →
 * `JOINGONKA_API_KEY`). Поэтому адаптер пишет ТОЛЬКО провайдера и каталог
 * моделей (самая муторная часть), а ключ печатает двумя вариантами на выбор.
 *
 * ★ settings.json — ГЛАВНЫЙ конфиг редактора и почти всегда JSONC с
 * комментариями пользователя. Пишем через jsonc-parser (modify + applyEdits)
 * ТОЧЕЧНО по путям: комментарии, форматирование и все прочие настройки
 * (темы, LSP, кейбинды) остаются нетронутыми. JSON.parse/stringify здесь
 * недопустим — снёс бы комментарии.
 *
 * Путь один для обоих scope. Учитывается XDG_CONFIG_HOME (док Zed).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  BASE_URL_OPENAI,
  OPENCLAW_MODELS,
  ZED_PROVIDER_ID,
  ZED_API_KEY_ENV,
  zedModelEntry,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Отступы правок — как в дефолтном settings.json Zed. */
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/**
 * Разрешение пути:
 *   1. env XDG_CONFIG_HOME (trim, непустой) → <XDG>/zed/settings.json;
 *   2. иначе ~/.config/zed/settings.json.
 * homedir()/env читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/env).
 */
function resolvePath(_scope: Scope): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome =
    typeof xdg === 'string' && xdg.trim() !== '' ? xdg.trim() : join(homedir(), '.config');
  return join(configHome, 'zed', 'settings.json');
}

/** Путь к нашему блоку провайдера внутри settings.json. */
const PROVIDER_PATH = ['language_models', 'openai_compatible', ZED_PROVIDER_ID];

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  const raw = readRaw(configPath);
  const backupPath = backup(configPath);

  // Битый JSONC → стартуем с пустого документа (бэкап уже сделан).
  let text = raw ?? '{}';
  if (raw != null) {
    const errors: ParseError[] = [];
    parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      text = '{}';
    }
  }

  // Каталог моделей строим FRESH: устаревшие модели прошлых версий установщика
  // (напр. Qwen) исчезают, потому что массив заменяется целиком.
  const availableModels = OPENCLAW_MODELS.map((spec) => zedModelEntry(spec));

  // Точечные правки по путям — чужие настройки и КОММЕНТАРИИ файла целы.
  // Ключ (api_key) НЕ пишем: Zed его отсюда не читает и док это запрещает.
  for (const [path, value] of [
    [[...PROVIDER_PATH, 'api_url'], BASE_URL_OPENAI],
    [[...PROVIDER_PATH, 'available_models'], availableModels],
  ] as Array<[Array<string | number>, unknown]>) {
    text = applyEdits(text, modify(text, path, value, { formattingOptions: FORMATTING }));
  }

  if (!text.endsWith('\n')) text += '\n';

  // Секретов в файле нет → права не форсим (write-file-atomic сохранит
  // существующие для уже созданного файла).
  await atomicWrite(configPath, text);

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Provider: ${ZED_PROVIDER_ID} → ${BASE_URL_OPENAI}`,
      `Models: ${OPENCLAW_MODELS.map((m) => m.id).join(', ')}`,
      '',
      // Единственный адаптер, который НЕ кладёт ключ в конфиг: так требует Zed.
      'Zed does NOT read API keys from settings.json, so the key was not written.',
      'Give Zed the key in either way:',
      `  1) export ${ZED_API_KEY_ENV}=${input.apiKey}`,
      '  2) or: agent panel → Settings → LLM Providers → paste it into the',
      `     "${ZED_PROVIDER_ID}" provider (stored in your OS keychain).`,
      '',
      `Then pick ${input.model} in the Agent Panel model selector.`,
      "Edit predictions (Zeta) stay on Zed's own models — a Zed limitation.",
    ],
  };
}

export const zedAdapter: Adapter = {
  id: 'zed',
  label: 'Zed (OpenAI-compatible)',
  format: 'json',
  apiMode: 'openai',
  resolvePath,
  apply,
};
