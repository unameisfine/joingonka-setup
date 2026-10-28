/**
 * OpenCode 2 — ключ в собственном хранилище OpenCode, а не только в auth.json.
 *
 * ★ Что сломалось (проверено вживую 28.10.2026 на OpenCode 2.2.0, npm `@opencode/cli`).
 * V2 держит ключи в SQLite (`opencode.db`, таблица `credential`; путь печатает
 * `opencode debug paths db`), а auth.json импортирует один раз — миграцией при
 * обновлении с 1.x. На свежей установке V2 миграция помечается выполненной без
 * запуска. Итог: после установщика `opencode auth list` → «No authenticated
 * integrations», запрос уходит без ключа, а live-проверка шлюза говорила «✓ Verified».
 * Формат конфига (`provider.joingonka`, формат 1.x) верен: его читают обе версии.
 *
 * ★ Как устроен CLI V2 (снято с 2.2.0 и 1.19.4, npm `opencode-ai`, тем же днём):
 *   - версия: `opencode --version` → «opencode v2.2.0» у V2 и «1.19.4» у V1; npm-пакет V2
 *     ставит ещё и `opencode2`. Каталог данных и `opencode.db` у V1 и V2 общие;
 *   - каждая команда V2 идёт через фоновый сервис `opencode serve --service`: первая
 *     команда его поднимает, и он живёт дальше (127.0.0.1:49374) — с окружением того,
 *     кто его поднял. `opencode service status` печатает `stopped`, сервиса не поднимая;
 *     с флагом `--standalone` команда работает частным сервером и демона не оставляет,
 *     а записанное ею сразу видит и уже работающий сервис (ключи он читает из базы).
 *     Поэтому без сервиса работаем через `--standalone`;
 *   - запущенный сервис видит только что записанный конфиг не сразу: до `opencode
 *     reload` (синхронный, 0,1 с) `auth logout` отвечает «Integration not found», а
 *     `auth list` провайдера не показывает;
 *   - `auth import` читает JSON со stdin (поле `id` обязательно). Запись с уже
 *     существующим id он НЕ заменяет: «Imported 0 credentials, skipped 1 already
 *     present» — и код выхода 0. Поэтому прежнюю НАШУ запись сначала снимаем:
 *     `auth logout joingonka cred_joingonka` (без терминала, если запись указана явно);
 *   - импортированная запись не становится активной, если у интеграции уже есть
 *     активная (ручной `auth login`, запись из миграции auth.json) — делаем её
 *     активной `auth switch joingonka cred_joingonka` (идемпотентно);
 *   - `auth list --format json` показывает интеграцию, только если провайдер есть в
 *     конфиге и у неё есть записи; `auth export joingonka` отдаёт записи с флагом
 *     `active` и самим ключом — по нему проверяем итог, а не по кодам выхода.
 *
 * Чужие записи интеграции joingonka (ручной `auth login`, перенос из auth.json) не
 * удаляем — только перестаём делать их активными. Интерактивный `opencode auth login`
 * установщику не годится (нужен терминал), а `--answer` положил бы ключ в аргументы
 * процесса; поэтому — import со stdin.
 */
import { existsSync } from 'node:fs';
import { OPENCODE_PROVIDER_ID } from '../constants.js';
import type { CommandResult, RunCommand } from '../core/commands.js';
import type { ToolCheck } from './types.js';

/** Id нашей записи в хранилище OpenCode 2 — по нему её заменяем и проверяем. */
export const OPENCODE2_CREDENTIAL_ID = 'cred_joingonka';

/** Имя записи в `opencode auth list` — то же, что имя провайдера в конфиге. */
const CREDENTIAL_LABEL = 'JoinGonka (Gonka)';

/** Версию спрашиваем быстро; команды хранилища ждут подъёма фонового сервиса. */
const VERSION_TIMEOUT_MS = 15_000;
const STORE_TIMEOUT_MS = 20_000;

/** Что нашлось на машине. */
export type OpencodeInstall =
  /** alongsideV1 — `opencode` остаётся 1.x (версия), а V2 стоит рядом как `opencode2`. */
  | { kind: 'v2'; bin: string; version: string; alongsideV1?: string }
  | { kind: 'v1'; version: string }
  | { kind: 'none'; reason: string };

/** Итог работы с хранилищем: строки для вывода и проверка самим OpenCode. */
export interface KeystoreSync {
  messages: string[];
  /** Нет поля — проверять нечего (OpenCode 1.x читает auth.json, его и пишем). */
  toolCheck?: ToolCheck;
}

/** Для OpenCode 2 проверка есть всегда. */
type CheckedKeystoreSync = KeystoreSync & { toolCheck: ToolCheck };

/** Версия из вывода `--version`: «opencode v2.2.0» → «2.2.0», «1.19.4» → «1.19.4». */
export function parseOpencodeVersion(output: string): string | null {
  const match = /(?:^|[\s(])v?(\d+\.\d+\.\d+)/m.exec(output);
  return match ? match[1]! : null;
}

const major = (version: string) => Number(version.split('.')[0]);

/** Снимает раскраску и рамку clack-интерфейса CLI, оставляет первую содержательную строку. */
function firstLine(text: string): string {
  return (
    text
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .split('\n')
      .map((line) => line.replace(/^[\s│┌└◇◆■●▲]+/u, '').trim())
      .find((line) => line !== '') ?? ''
  );
}

/** Ключи в тексте программы не показываем никогда — ни наш, ни чужой. */
function mask(text: string, apiKey: string): string {
  return text.split(apiKey).join('jg-…').replace(/jg-[A-Za-z0-9_-]{6,}/g, 'jg-…');
}

/** Причина неудачи одной строкой — для пользователя, без ключа. */
function reasonOf(result: CommandResult, apiKey: string): string {
  if (result.error === 'timeout') return 'timed out';
  if (result.error === 'not-found') return 'command not found';
  const line = firstLine(result.stderr) || firstLine(result.stdout);
  const text = line === '' ? `exit code ${String(result.code)}` : line;
  return mask(text.length > 200 ? `${text.slice(0, 200)}…` : text, apiKey);
}

/** Что напечатал `--version` — для сообщения, когда версию прочитать не удалось. */
async function askVersion(run: RunCommand, bin: string) {
  const result = await run(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
  const version = result.code === 0 ? parseOpencodeVersion(result.stdout) : null;
  return { result, version };
}

/**
 * Какой OpenCode стоит на машине. V2 ищем под обоими именами: `opencode` может
 * оставаться 1.x, когда V2 поставлен рядом как `opencode2`.
 */
export async function detectOpencode(run: RunCommand): Promise<OpencodeInstall> {
  const main = await askVersion(run, 'opencode');
  if (main.version !== null && major(main.version) >= 2) {
    return { kind: 'v2', bin: 'opencode', version: main.version };
  }

  const second = await askVersion(run, 'opencode2');
  if (second.version !== null && major(second.version) >= 2) {
    const v1 = main.version !== null && major(main.version) === 1 ? { alongsideV1: main.version } : {};
    return { kind: 'v2', bin: 'opencode2', version: second.version, ...v1 };
  }

  if (main.version !== null && major(main.version) === 1) return { kind: 'v1', version: main.version };

  if (main.result.error === 'not-found') {
    return { kind: 'none', reason: 'the opencode command was not found' };
  }
  // 0.x — не OpenCode, а старый одноимённый Go-инструмент (ныне Crush).
  if (main.version !== null) {
    return {
      kind: 'none',
      reason: `\`opencode --version\` printed ${main.version}, which is neither OpenCode 1.x nor 2.x`,
    };
  }
  const printed = firstLine(main.result.stdout) || firstLine(main.result.stderr);
  return {
    kind: 'none',
    reason: `\`opencode --version\` did not print an OpenCode version${printed ? ` ("${printed.slice(0, 80)}")` : ''}`,
  };
}

/** Запись для `auth import` — формат `auth export` OpenCode 2. */
function importPayload(apiKey: string): string {
  return JSON.stringify([
    {
      id: OPENCODE2_CREDENTIAL_ID,
      integrationID: OPENCODE_PROVIDER_ID,
      label: CREDENTIAL_LABEL,
      active: true,
      value: { type: 'key', key: apiKey },
    },
  ]);
}

/** Id записей интеграции joingonka из `auth list --format json`; null — ответ не прочитан. */
function listedCredentials(result: CommandResult): string[] | null {
  if (result.code !== 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const entry = data.find((item) => (item as { id?: unknown } | null)?.id === OPENCODE_PROVIDER_ID) as
    | { connections?: unknown }
    | undefined;
  const connections = Array.isArray(entry?.connections) ? entry.connections : [];
  return connections
    .filter((c) => (c as { type?: unknown } | null)?.type === 'credential')
    .map((c) => String((c as { id?: unknown }).id));
}

/** Наша запись глазами `auth export`: активна ли и с тем ли ключом. */
type ExportedState = 'ok' | 'other-key' | 'inactive' | 'absent' | 'unreadable';

function exportedState(result: CommandResult, apiKey: string): ExportedState {
  if (result.code !== 0) return 'unreadable';
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return 'unreadable';
  }
  if (!Array.isArray(data)) return 'unreadable';
  const record = data.find((item) => (item as { id?: unknown } | null)?.id === OPENCODE2_CREDENTIAL_ID) as
    | { active?: unknown; value?: { key?: unknown } }
    | undefined;
  if (record === undefined) return 'absent';
  if (record.value?.key !== apiKey) return 'other-key';
  return record.active === true ? 'ok' : 'inactive';
}

/** Как вписать ключ руками — той командой, под которой стоит OpenCode 2. */
const manualFix = (bin: string) =>
  `Fix: run \`${bin} auth login joingonka\`, choose to enter the API key manually and paste your key — or re-run this installer.`;

/**
 * Кладёт ключ в хранилище OpenCode 2 и проверяет, что OpenCode его видит.
 * Порядок и почему он такой — в шапке файла. Не бросает: любая неудача — это
 * `missing` с причиной и командой исправления.
 */
export async function storeKeyInOpencode2(
  run: RunCommand,
  install: { bin: string; version: string },
  apiKey: string,
): Promise<CheckedKeystoreSync> {
  const { bin } = install;
  const missing = (reason: string): CheckedKeystoreSync => ({
    messages: [],
    toolCheck: {
      status: 'missing',
      detail: `OpenCode 2 (${bin} v${install.version}) does not see the JoinGonka key yet: ${reason}.`,
      fix: manualFix(bin),
    },
  });

  // 0) Фоновый сервис. Не запущен — работаем частным сервером (`--standalone`): иначе
  //    первая же команда подняла бы сервис с окружением установщика (npx), и он
  //    обслуживал бы потом сессии пользователя. Частный сервер читает конфиг заново
  //    и пишет в ту же базу — запущенный позже сервис увидит ключ.
  const status = await run(bin, ['service', 'status'], { timeoutMs: VERSION_TIMEOUT_MS });
  const standalone = status.code === 0 && firstLine(status.stdout).toLowerCase() === 'stopped';
  const call = (args: string[], input?: string) =>
    run(bin, standalone ? [...args, '--standalone'] : args, {
      timeoutMs: STORE_TIMEOUT_MS,
      ...(input !== undefined ? { input } : {}),
    });

  // 1) Уже запущенный сервис должен увидеть провайдера, записанного только что.
  if (!standalone) {
    const reloaded = await call(['reload']);
    if (reloaded.error !== undefined) return missing(`\`${bin} reload\` ${reasonOf(reloaded, apiKey)}`);
  }

  // 2) Прежняя наша запись: import её не заменяет, поэтому снимаем её заранее.
  const before = listedCredentials(await call(['auth', 'list', '--format', 'json']));
  if (before?.includes(OPENCODE2_CREDENTIAL_ID)) {
    const removed = await call(['auth', 'logout', OPENCODE_PROVIDER_ID, OPENCODE2_CREDENTIAL_ID]);
    if (removed.code !== 0) {
      return missing(`the previous JoinGonka key could not be removed (${reasonOf(removed, apiKey)})`);
    }
  }

  // 3) Ключ — только через stdin.
  const imported = await call(['auth', 'import'], importPayload(apiKey));
  if (imported.code !== 0) return missing(`\`${bin} auth import\` failed (${reasonOf(imported, apiKey)})`);
  if (/\bImported 0 credentials\b/.test(imported.stdout)) {
    return missing(`\`${bin} auth import\` kept the previous record ("${reasonOf(imported, apiKey)}")`);
  }

  // 4) Наша запись — активная, даже если рядом есть другая (ручной вход, миграция).
  const switched = await call(['auth', 'switch', OPENCODE_PROVIDER_ID, OPENCODE2_CREDENTIAL_ID]);
  if (switched.code !== 0) {
    return missing(`the key could not be made the active JoinGonka account (${reasonOf(switched, apiKey)})`);
  }

  // 5) Проверка тем, что видит сам OpenCode: запись в списке и именно с этим ключом.
  const listedResult = await call(['auth', 'list', '--format', 'json']);
  const after = listedCredentials(listedResult);
  if (after === null) return missing(`\`${bin} auth list\` failed (${reasonOf(listedResult, apiKey)})`);
  if (!after.includes(OPENCODE2_CREDENTIAL_ID)) {
    return missing(`\`${bin} auth list\` does not show JoinGonka as stored`);
  }

  const state = exportedState(await call(['auth', 'export', OPENCODE_PROVIDER_ID]), apiKey);
  if (state === 'other-key') return missing('it holds a different JoinGonka key than the one just given');
  if (state === 'inactive') return missing('another JoinGonka account is active');
  if (state === 'absent') return missing(`\`${bin} auth export\` does not return the JoinGonka key`);
  // 'unreadable' — export недоступен или сменил формат: остаётся проверка списком выше.

  return {
    messages: [`Stored the key in the OpenCode 2 credential store (\`${bin} auth import\`, v${install.version})`],
    toolCheck: {
      status: 'ok',
      detail: `OpenCode 2 sees the key: \`${bin} auth list\` shows JoinGonka (Gonka) as stored.`,
    },
  };
}

/**
 * `opencode` — это 1.x, а V2 стоит рядом как `opencode2`. Базу, которую OpenCode 2
 * создаёт первым, 1.x не открывает («Database is not empty and has no session
 * table», проверено 28.10.2026 на 1.19.4) и не запускается; базу, созданную 1.x,
 * OpenCode 2 переносит на месте, и 1.x работает дальше. Поэтому, пока базы нет,
 * OpenCode 2 не трогаем. `debug paths db` печатает путь, не создавая базы и не
 * поднимая сервиса. null — база есть, можно продолжать.
 */
async function guardOpencode1(
  run: RunCommand,
  install: { bin: string; version: string },
  v1Version: string,
): Promise<KeystoreSync | null> {
  const db = await run(install.bin, ['debug', 'paths', 'db'], { timeoutMs: VERSION_TIMEOUT_MS });
  const dbPath = db.code === 0 ? firstLine(db.stdout) : '';
  if (dbPath !== '' && existsSync(dbPath)) return null;
  return {
    messages: [],
    toolCheck: {
      status: 'unknown',
      detail:
        `Your \`opencode\` is OpenCode ${v1Version} and it has the key. OpenCode 2 (\`${install.bin}\` v${install.version}) ` +
        `was left alone: it has no database here yet, and a database OpenCode 2 creates first stops OpenCode ${v1Version} from starting.`,
      fix:
        `Once OpenCode ${v1Version} has been started here, re-run this installer — or, when you move to OpenCode 2, ` +
        `run \`${install.bin} auth login joingonka\` and paste your key.`,
    },
  };
}

/** Подсказка, когда OpenCode 2 проверить нечем. */
const NOT_CHECKED_FIX =
  'If you use OpenCode 2: run `opencode auth login joingonka`, choose to enter the API key manually and paste your key — ' +
  'or re-run this installer once OpenCode 2 is installed. OpenCode 1.x reads auth.json and needs nothing more.';

/**
 * Ключ для той версии OpenCode, что стоит на машине: V2 — import в его хранилище,
 * V1 — ничего сверх auth.json, не найден — подсказка. Не бросает.
 */
export async function syncOpencodeKeystore(run: RunCommand | undefined, apiKey: string): Promise<KeystoreSync> {
  if (run === undefined) {
    return {
      messages: [],
      toolCheck: { status: 'unknown', detail: 'OpenCode 2 was not checked.', fix: NOT_CHECKED_FIX },
    };
  }
  try {
    const install = await detectOpencode(run);
    if (install.kind === 'v2' && install.alongsideV1 !== undefined) {
      const guarded = await guardOpencode1(run, install, install.alongsideV1);
      if (guarded !== null) return guarded;
    }
    if (install.kind === 'v2') return await storeKeyInOpencode2(run, install, apiKey);
    if (install.kind === 'v1') {
      return {
        messages: [
          `Found opencode ${install.version}: it reads the key from auth.json — nothing else to do.`,
          'If you move to OpenCode 2 later, re-run this installer: OpenCode 2 keeps keys in its own store.',
        ],
      };
    }
    return {
      messages: [],
      toolCheck: {
        status: 'unknown',
        detail: `The OpenCode 2 key store was not checked: ${install.reason}.`,
        fix: NOT_CHECKED_FIX,
      },
    };
  } catch (err) {
    // Защита от неожиданного: конфиг и auth.json уже записаны, установку не роняем.
    return {
      messages: [],
      toolCheck: {
        status: 'missing',
        detail: `Could not hand the key to OpenCode 2: ${mask((err as Error).message, apiKey)}.`,
        fix: manualFix('opencode'),
      },
    };
  }
}
