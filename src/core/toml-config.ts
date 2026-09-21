/**
 * Безопасное чтение и ТОЧЕЧНАЯ правка TOML-конфигов инструментов
 * (Codex CLI — ~/.codex/config.toml, Kimi Code CLI — ~/.kimi-code/config.toml).
 *
 * ★ Зачем отдельный модуль, а не «разобрать → поменять → сериализовать».
 * Сериализация TOML-документа целиком теряет всё, что человек писал руками:
 * комментарии, порядок таблиц, стиль кавычек, многострочные массивы. Зрелой
 * маленькой библиотеки с правкой «на месте» под Node нет, поэтому парсер
 * (smol-toml — тот же, которым читает свой конфиг сам Kimi Code CLI) здесь
 * только ЧИТАЕТ и ПРОВЕРЯЕТ, а правки — текстовые и точечные. Тот же приём у
 * JSON-конфигов даёт core/json-config.ts.
 *
 * Три операции (`TomlEdit`):
 *   set         — значение ключа в таблице (пустой путь таблицы = верхний уровень).
 *                 Ключ есть → меняется ТОЛЬКО значение (хвостовой комментарий и
 *                 соседние строки целы); ключа нет → строка дописывается после
 *                 последнего ключа таблицы; таблицы нет → она добавляется в конец
 *                 файла. Значение уже такое (даже записанное иначе: одинарные
 *                 кавычки, многострочный массив) → текст не трогается вовсе;
 *   remove      — строка(и) одного ключа таблицы;
 *   removeTable — таблица от заголовка до последнего её ключа, вместе с
 *                 подтаблицами. Комментарии НАД заголовком не удаляются никогда.
 *
 * ★ Что считается неподдерживаемой формой. Править умеем только таблицу,
 * объявленную заголовком `[a.b]`. Та же таблица может быть записана точечными
 * ключами (`a.b.key = …`), inline-таблицей (`a = { b = { … } }`) или массивом
 * таблиц (`[[a.b]]`) — угадывать правку в таких формах не берёмся: отказ с путём
 * файла и понятным текстом, файл не тронут. Родитель, записанный inline-таблицей,
 * заголовком расширить нельзя по спецификации TOML — это тоже отказ.
 *
 * ★ Страховка (assertOnlyIntendedChanges). Сканер строк ниже — наш, и ошибиться
 * он может. Поэтому параллельно с текстом ведётся «ожидаемое значение»: разбор
 * исходного файла, к которому те же правки применены как к объекту. Итоговый
 * текст обязан (1) разбираться и (2) дать РОВНО ожидаемое значение — то есть
 * отличаться от исходного только по нашим путям. Иначе — отказ «Nothing was
 * written». На диск не уходит то, что сломает инструмент или заденет чужой ключ.
 *
 * ★ Вызывать ДО бэкапа и записи (как applyJsonEdits): любой отказ обязан
 * оставить диск нетронутым — ни записи, ни лишнего `.bak`.
 *
 * В текст ошибок содержимое файла не попадает никогда: в этих конфигах лежат
 * API-ключи (сообщение smol-toml содержит фрагмент файла — берём только его
 * первую строку, она у библиотеки всегда статическая).
 */
import { parse, TomlError } from 'smol-toml';

/** Разобранная TOML-таблица (значения — как их отдаёт парсер). */
export type TomlTable = Record<string, unknown>;

/** Скаляр, который умеем записать. Числа — только целые (других в конфигах не пишем). */
export type TomlScalar = string | number | boolean;

/** Значение для записи: скаляр либо однострочный массив скаляров. */
export type TomlEditValue = TomlScalar | readonly TomlScalar[];

/** Одна правка. `table` — путь таблицы; пустой массив — верхний уровень файла. */
export type TomlEdit =
  | { op: 'set'; table: readonly string[]; key: string; value: TomlEditValue }
  | { op: 'remove'; table: readonly string[]; key: string }
  | { op: 'removeTable'; table: readonly string[] };

/** Разобранный конфиг: исходный текст для правок + значение для решений. */
export interface TomlConfigDoc {
  /** ИСХОДНЫЙ текст файла ('' для нового). Правки применяются к нему. */
  text: string;
  /** Разобранное значение — только для чтения: «что уже задано у пользователя». */
  value: TomlTable;
}

/** Общая концовка отказа — та же, что у core/json-config. */
const REFUSAL_HINT =
  'Nothing was written — fix the file (or move it aside) and run the installer again.';

const ISSUES_URL = 'https://github.com/unameisfine/joingonka-setup/issues';

/** Отказ: путь файла, что не так, «Nothing was written». */
function refuse(filePath: string, what: string): never {
  throw new Error(`${filePath}: ${what} ${REFUSAL_HINT}`);
}

/**
 * BOM в начале файла (Блокнот Windows): Rust-парсер Codex его принимает, smol-toml —
 * нет. Снимаем перед разбором и возвращаем на место в итоговом тексте.
 */
const BOM = '\uFEFF';

function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(BOM.length) } : { bom: '', body: text };
}

/**
 * Разбор текста. Целые вне безопасного диапазона отдаются как bigint, а не
 * отказом: чужое большое число — не повод не трогать файл.
 */
function parseToml(text: string): TomlTable {
  return parse(text, { integersAsBigInt: 'asNeeded' }) as TomlTable;
}

/** Причина ошибки парсера без фрагмента файла: строка, колонка, статический текст. */
function parserReason(err: unknown): string {
  if (err instanceof TomlError) {
    const summary = (err.message.split('\n')[0] ?? '').replace(/^Invalid TOML document:\s*/, '');
    return `line ${err.line}, column ${err.column}: ${summary}`;
  }
  return 'the parser failed';
}

/** true для TOML-таблицы (не массив, не дата, не null). */
function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Таблица либо undefined — безопасный доступ для адаптеров. */
export function tomlTable(value: unknown): TomlTable | undefined {
  return isTable(value) ? value : undefined;
}

/**
 * Читает конфиг инструмента. Файла нет (`null`) или он пуст → пустой документ.
 * Разобрать нельзя → исключение; вызывающий адаптер к этому моменту ещё НИЧЕГО
 * не записал и не должен.
 */
export function readTomlConfig(raw: string | null, filePath: string): TomlConfigDoc {
  if (raw == null) return { text: '', value: {} };
  if (raw.trim() === '') return { text: raw, value: {} };
  try {
    return { text: raw, value: parseToml(splitBom(raw).body) };
  } catch (err) {
    throw new Error(`${filePath} is not valid TOML (${parserReason(err)}). ${REFUSAL_HINT}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Запись значений и ключей
// ────────────────────────────────────────────────────────────────────────────

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

/** Базовая TOML-строка в двойных кавычках. */
function formatString(value: string): string {
  const body = value.replace(
    // eslint-disable-next-line no-control-regex
    /[\\"\u0000-\u001f\u007f]/g,
    (ch) => STRING_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${body}"`;
}

function formatScalar(value: TomlScalar): string {
  if (typeof value === 'string') return formatString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Internal error: only integers are written into TOML configs, got ${value}.`);
  }
  return String(value);
}

function isList(value: TomlEditValue): value is readonly TomlScalar[] {
  return Array.isArray(value);
}

function formatValue(value: TomlEditValue): string {
  return isList(value) ? `[${value.map(formatScalar).join(', ')}]` : formatScalar(value);
}

function formatKey(key: string): string {
  return BARE_KEY.test(key) ? key : formatString(key);
}

/** Путь для заголовка таблицы и сообщений: `models."joingonka/a.b"`. */
export function formatTomlPath(path: readonly string[]): string {
  return path.map(formatKey).join('.');
}

/** Как назвать человеку значение, занявшее место таблицы. */
function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a date';
  if (isTable(value)) return 'a table';
  return `a ${typeof value}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Сравнение разобранных значений
// ────────────────────────────────────────────────────────────────────────────

function sameDate(a: Date, b: Date): boolean {
  // У TomlDate вид даты (локальная дата, время, смещение) виден только в
  // toISOString(); у невалидной даты он бросает — тогда сравниваем как строки.
  try {
    return a.toISOString() === b.toISOString();
  } catch {
    return String(a) === String(b);
  }
}

/** Глубокое равенство значений TOML (таблицы — без учёта порядка ключей). */
function tomlDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date && b instanceof Date) return sameDate(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => tomlDeepEqual(item, b[index]));
  }
  if (isTable(a) && isTable(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && tomlDeepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Страховка: итоговый текст обязан разбираться и дать ровно `expected` — исходное
 * значение файла, к которому правки применены как к объекту.
 */
export function assertOnlyIntendedChanges(
  resultText: string,
  expected: TomlTable,
  filePath: string,
): void {
  let actual: TomlTable;
  try {
    actual = resultText.trim() === '' ? {} : parseToml(resultText);
  } catch (err) {
    refuse(
      filePath,
      'the installer could not add its settings without breaking the file ' +
        `(${parserReason(err)}). The usual cause: a parent table is written inline ` +
        '(`name = { ... }`), and TOML does not let a [name.child] header extend it.',
    );
  }
  if (!tomlDeepEqual(actual, expected)) {
    throw new Error(
      `Internal error: the edited ${filePath} would differ from the intended result, so other ` +
        `settings could be affected. Nothing was written — please report this at ${ISSUES_URL}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Сканер раскладки: где в тексте заголовки таблиц и строки «ключ = значение»
// ────────────────────────────────────────────────────────────────────────────

interface Header {
  kind: 'table' | 'array';
  path: string[];
  /** Начало строки заголовка. */
  lineStart: number;
  /** Позиция сразу за переводом строки заголовка. */
  end: number;
}

interface Statement {
  /** Путь ключа ОТНОСИТЕЛЬНО своей таблицы (больше одного сегмента — точечный ключ). */
  keyPath: string[];
  lineStart: number;
  valueStart: number;
  /** Позиция сразу за значением (хвостовой комментарий в значение не входит). */
  valueEnd: number;
  /** Позиция сразу за переводом строки (у многострочного значения — последней). */
  end: number;
}

/** Блок: заголовок (null — область верхнего уровня до первого заголовка) и его ключи. */
interface Block {
  header: Header | null;
  statements: Statement[];
}

/** Сканер споткнулся на тексте, который парсер принял, — значит, ошибка в сканере. */
function layoutError(): Error {
  return new Error('layout');
}

function skipInlineSpace(text: string, pos: number): number {
  let p = pos;
  while (text[p] === ' ' || text[p] === '\t') p += 1;
  return p;
}

/** Позиция сразу за ближайшим переводом строки (или конец текста). */
function afterLineBreak(text: string, pos: number): number {
  const index = text.indexOf('\n', pos);
  return index === -1 ? text.length : index + 1;
}

/** Конец базовой строки: позиция сразу за закрывающей кавычкой. `from` — за открывающей. */
function endOfBasicString(text: string, from: number): number {
  let p = from;
  while (p < text.length) {
    const ch = text[p];
    if (ch === '\\') p += 2;
    else if (ch === '"') return p + 1;
    else p += 1;
  }
  throw layoutError();
}

function endOfLiteralString(text: string, from: number): number {
  const close = text.indexOf("'", from);
  if (close === -1) throw layoutError();
  return close + 1;
}

/** Кавычка на позиции `index` экранирована нечётным числом обратных косых перед ней. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (text[index - 1 - slashes] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

/**
 * Конец многострочной строки. `from` — позиция за открывающими тремя кавычками.
 * Перед закрывающей тройкой содержимому могут принадлежать ещё до двух кавычек
 * (`""""` в конце — это кавычка в тексте плюс закрытие).
 */
function endOfMultilineString(text: string, from: number, quote: '"' | "'"): number {
  const fence = quote.repeat(3);
  let p = from;
  for (;;) {
    const index = text.indexOf(fence, p);
    if (index === -1) throw layoutError();
    if (quote === '"' && isEscaped(text, index)) {
      p = index + 1;
      continue;
    }
    let end = index + 3;
    while (end < index + 5 && text[end] === quote) end += 1;
    return end;
  }
}

/**
 * Пропускает значение и возвращает позицию сразу за ним. Внутри массивов и
 * inline-таблиц (TOML 1.1 разрешает им занимать несколько строк) следим только
 * за тем, что меняет границы: строки, скобки, комментарии.
 */
function skipValue(text: string, start: number): number {
  let depth = 0;
  let p = start;
  let end = start;
  while (p < text.length) {
    const ch = text[p]!;
    if (ch === '"') {
      p = text.startsWith('"""', p) ? endOfMultilineString(text, p + 3, '"') : endOfBasicString(text, p + 1);
      end = p;
      continue;
    }
    if (ch === "'") {
      p = text.startsWith("'''", p) ? endOfMultilineString(text, p + 3, "'") : endOfLiteralString(text, p + 1);
      end = p;
      continue;
    }
    if (ch === '#') {
      if (depth === 0) break;
      const lineBreak = text.indexOf('\n', p);
      p = lineBreak === -1 ? text.length : lineBreak;
      continue;
    }
    if (ch === '\n' && depth === 0) break;
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') end = p + 1;
    p += 1;
  }
  return end;
}

/**
 * Читает (возможно точечный) ключ начиная с `pos`. Экранирование в ключах в
 * кавычках раскрывает сам парсер — так сегмент гарантированно совпадает с тем,
 * что лежит в разобранном значении.
 */
function readKeyPath(text: string, pos: number): { path: string[]; end: number } {
  const path: string[] = [];
  let p = pos;
  for (;;) {
    p = skipInlineSpace(text, p);
    const ch = text[p];
    if (ch === '"') {
      const close = endOfBasicString(text, p + 1);
      path.push(String(parseToml(`k = ${text.slice(p, close)}`).k));
      p = close;
    } else if (ch === "'") {
      const close = endOfLiteralString(text, p + 1);
      path.push(text.slice(p + 1, close - 1));
      p = close;
    } else {
      const bare = /[A-Za-z0-9_-]+/y;
      bare.lastIndex = p;
      const match = bare.exec(text);
      if (!match) throw layoutError();
      path.push(match[0]);
      p += match[0].length;
    }
    const next = skipInlineSpace(text, p);
    if (text[next] !== '.') return { path, end: p };
    p = next + 1;
  }
}

/** Раскладка файла по блокам. Первый блок — всегда область верхнего уровня. */
function scanLayout(text: string): Block[] {
  const blocks: Block[] = [{ header: null, statements: [] }];
  let pos = 0;
  while (pos < text.length) {
    const lineStart = pos;
    pos = skipInlineSpace(text, pos);
    const ch = text[pos];
    if (ch === undefined) break;
    if (ch === '\n' || ch === '\r') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      pos = afterLineBreak(text, pos);
      continue;
    }
    if (ch === '[') {
      const isArray = text[pos + 1] === '[';
      const key = readKeyPath(text, pos + (isArray ? 2 : 1));
      const close = skipInlineSpace(text, key.end);
      if (text[close] !== ']') throw layoutError();
      const end = afterLineBreak(text, close);
      blocks.push({
        header: { kind: isArray ? 'array' : 'table', path: key.path, lineStart, end },
        statements: [],
      });
      pos = end;
      continue;
    }
    const key = readKeyPath(text, pos);
    const equals = skipInlineSpace(text, key.end);
    if (text[equals] !== '=') throw layoutError();
    const valueStart = skipInlineSpace(text, equals + 1);
    const valueEnd = skipValue(text, valueStart);
    const end = afterLineBreak(text, valueEnd);
    blocks[blocks.length - 1]!.statements.push({
      keyPath: key.path,
      lineStart,
      valueStart,
      valueEnd,
      end,
    });
    pos = end;
  }
  return blocks;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length && prefix.every((segment, index) => segment === path[index]);
}

/** Блок таблицы, объявленной заголовком `[path]`; для пустого пути — верхний уровень. */
function findBlock(layout: Block[], table: readonly string[]): Block | undefined {
  if (table.length === 0) return layout[0];
  return layout.find((block) => block.header?.kind === 'table' && samePath(block.header.path, table));
}

function findStatement(block: Block, key: string): Statement | undefined {
  return block.statements.find((s) => s.keyPath.length === 1 && s.keyPath[0] === key);
}

// ────────────────────────────────────────────────────────────────────────────
// Правки текста
// ────────────────────────────────────────────────────────────────────────────

/** Состояние правки: текст и «ожидаемое значение» идут параллельно. */
interface EditState {
  text: string;
  value: TomlTable;
  eol: string;
  filePath: string;
}

/** Строка состоит только из пробелов (или её нет — конец текста). */
function startsWithBlankLine(text: string): RegExpExecArray | null {
  return /^[ \t]*(\r?\n|$)/.exec(text);
}

function endsWithBlankLine(text: string): boolean {
  return /(^|\n)[ \t]*\r?\n$/.test(text);
}

/** Сообщение «форма записи, которую править не умеем». */
function unsupportedForm(state: EditState, path: readonly string[]): never {
  const shown = formatTomlPath(path);
  return refuse(
    state.filePath,
    `"${shown}" is written in a form this installer cannot edit safely (dotted keys, an inline ` +
      `table or an array of tables). Rewrite it as a plain [${shown}] table (or remove it).`,
  );
}

/**
 * Идёт по пути таблицы в ожидаемом значении. Возвращает таблицу либо undefined,
 * если её (или предка) ещё нет. Не-таблица на пути — отказ: чужое значение не
 * затираем, человек мог положить его намеренно.
 */
function tableAt(state: EditState, table: readonly string[]): TomlTable | undefined {
  let node: TomlTable = state.value;
  for (let depth = 0; depth < table.length; depth += 1) {
    const next = node[table[depth]!];
    if (next === undefined) return undefined;
    if (!isTable(next)) {
      refuse(
        state.filePath,
        `"${formatTomlPath(table.slice(0, depth + 1))}" is expected to be a table, ` +
          `but it is ${describeType(next)}.`,
      );
    }
    node = next;
  }
  return node;
}

/** Значение по пути в разобранном документе; undefined, если пути нет. */
function valueAt(root: TomlTable, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (!isTable(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Создаёт недостающие таблицы пути в ожидаемом значении. */
function ensureTable(state: EditState, table: readonly string[]): TomlTable {
  let node = state.value;
  for (const segment of table) {
    if (!isTable(node[segment])) node[segment] = {};
    node = node[segment] as TomlTable;
  }
  return node;
}

/**
 * Куда вставить ПЕРВЫЙ ключ верхнего уровня: под «шапку» файла (блок комментариев
 * в самом начале, за которым идёт пустая строка), иначе в самое начало. Комментарий,
 * прижатый к заголовку таблицы, относится к ней — над ним и вставляем.
 */
function firstRootKeyOffset(text: string): number {
  let pos = 0;
  while (text[skipInlineSpace(text, pos)] === '#') pos = afterLineBreak(text, pos);
  if (pos === 0) return 0;
  const blank = startsWithBlankLine(text.slice(pos));
  return blank && blank[0].length > 0 ? pos + blank[0].length : 0;
}

/** Вставка строки `ключ = значение` в блок. */
function insertStatement(state: EditState, block: Block, line: string): void {
  const { text, eol } = state;
  const last = block.statements[block.statements.length - 1];
  if (last || block.header) {
    const offset = last ? last.end : block.header!.end;
    // Последняя строка файла могла быть без перевода строки.
    const glue = offset > 0 && text[offset - 1] !== '\n' ? eol : '';
    state.text = text.slice(0, offset) + glue + line + eol + text.slice(offset);
    return;
  }
  const offset = firstRootKeyOffset(text);
  const rest = text.slice(offset);
  // Отделяем новую группу ключей от того, что идёт ниже (заголовок, комментарий).
  const gap = rest.length > 0 && !startsWithBlankLine(rest) ? eol : '';
  state.text = text.slice(0, offset) + line + eol + gap + rest;
}

/** Новая таблица — в конец файла, через одну пустую строку. */
function appendTable(state: EditState, table: readonly string[]): void {
  let out = state.text;
  if (out.length > 0 && !out.endsWith('\n')) out += state.eol;
  if (out.trim() !== '' && !endsWithBlankLine(out)) out += state.eol;
  state.text = `${out}[${formatTomlPath(table)}]${state.eol}`;
}

function applySet(state: EditState, edit: Extract<TomlEdit, { op: 'set' }>): void {
  const { table, key, value } = edit;
  const owner = tableAt(state, table);
  const current = owner?.[key];
  const fullPath = [...table, key];

  if (isTable(current)) {
    refuse(
      state.filePath,
      `"${formatTomlPath(fullPath)}" is a table, but the installer needs to put a plain value there.`,
    );
  }
  // Уже так — текст не трогаем, даже если человек записал значение иначе.
  if (current !== undefined && tomlDeepEqual(current, value)) return;

  let block = findBlock(scanLayout(state.text), table);
  if (!block) {
    // Значение у таблицы есть, а заголовка нет: либо она неявная (есть только
    // заголовки подтаблиц — тогда свой заголовок добавить можно), либо записана
    // точечными ключами или inline — такое не правим.
    const implicit = scanLayout(state.text).some(
      (b) => b.header !== null && b.header.path.length > table.length && startsWithPath(b.header.path, table),
    );
    if (owner !== undefined && !implicit) unsupportedForm(state, table);
    appendTable(state, table);
    block = findBlock(scanLayout(state.text), table);
    if (!block) throw layoutError();
  }

  const statement = findStatement(block, key);
  if (statement) {
    state.text =
      state.text.slice(0, statement.valueStart) + formatValue(value) + state.text.slice(statement.valueEnd);
  } else {
    // Значение есть, а простой строки нет: массив таблиц `[[…]]` на месте ключа.
    if (current !== undefined) unsupportedForm(state, fullPath);
    insertStatement(state, block, `${formatKey(key)} = ${formatValue(value)}`);
  }
  ensureTable(state, table)[key] = isList(value) ? [...value] : value;
}

function applyRemove(state: EditState, edit: Extract<TomlEdit, { op: 'remove' }>): void {
  const { table, key } = edit;
  const owner = tableAt(state, table);
  if (owner === undefined || owner[key] === undefined) return;

  const block = findBlock(scanLayout(state.text), table);
  const statement = block ? findStatement(block, key) : undefined;
  if (!statement) unsupportedForm(state, [...table, key]);

  state.text = state.text.slice(0, statement.lineStart) + state.text.slice(statement.end);
  delete owner[key];
}

/** Вырезает диапазон и не оставляет на его месте двух пустых строк подряд. */
function cutRange(text: string, from: number, to: number): string {
  let before = text.slice(0, from);
  let after = text.slice(to);
  if (before.length === 0 || endsWithBlankLine(before)) {
    const blank = startsWithBlankLine(after);
    if (blank) after = after.slice(blank[0].length);
  }
  if (after.length === 0) before = before.replace(/(\r?\n)[ \t]*\r?\n$/, '$1');
  return before + after;
}

function applyRemoveTable(state: EditState, edit: Extract<TomlEdit, { op: 'removeTable' }>): void {
  const { table } = edit;
  const parent = tableAt(state, table.slice(0, -1));
  const name = table[table.length - 1]!;
  const current = parent?.[name];
  if (parent === undefined || current === undefined) return;
  if (!isTable(current)) {
    refuse(
      state.filePath,
      `"${formatTomlPath(table)}" is expected to be a table, but it is ${describeType(current)}.`,
    );
  }

  const blocks = scanLayout(state.text).filter(
    (block) => block.header !== null && startsWithPath(block.header.path, table),
  );
  if (blocks.length === 0) unsupportedForm(state, table);

  // С конца к началу — так смещения ещё не вырезанных блоков остаются верными.
  let text = state.text;
  for (const block of [...blocks].reverse()) {
    const last = block.statements[block.statements.length - 1];
    text = cutRange(text, block.header!.lineStart, last ? last.end : block.header!.end);
  }
  // Заголовки убраны, а таблица всё ещё есть — значит, часть её записана точечными
  // ключами или inline у родителя. Такое не правим (и понятнее сказать об этом
  // здесь, чем довести до общей страховки).
  if (valueAt(text.trim() === '' ? {} : parseToml(text), table) !== undefined) {
    unsupportedForm(state, table);
  }
  state.text = text;
  delete parent[name];

  // Неявный предок (`models` при единственной `[models.x]`) исчезает вместе с
  // последней подтаблицей; объявленный заголовком — остаётся пустой таблицей.
  const layout = scanLayout(state.text);
  for (let depth = table.length - 1; depth >= 1; depth -= 1) {
    const ancestorPath = table.slice(0, depth);
    const holder = tableAt(state, ancestorPath.slice(0, -1));
    const ancestor = holder?.[ancestorPath[depth - 1]!];
    const stillDeclared = layout.some(
      (block) => block.header !== null && startsWithPath(block.header.path, ancestorPath),
    );
    if (!holder || !isTable(ancestor) || Object.keys(ancestor).length > 0 || stillDeclared) break;
    delete holder[ancestorPath[depth - 1]!];
  }
}

/**
 * Применяет правки по очереди и возвращает итоговый текст (с переводом строки в
 * конце). Каждая правка работает по уже изменённому тексту, поэтому порядок
 * значим. Отказ — исключением; вызывать ДО бэкапа и записи.
 *
 * @param filePath путь к файлу — для сообщений об отказе.
 */
export function applyTomlEdits(text: string, edits: readonly TomlEdit[], filePath: string): string {
  const { bom, body } = splitBom(text);
  const state: EditState = {
    text: body,
    // Отдельный разбор, а не копия: так в «ожидаемом значении» остаются родные
    // объекты парсера (TomlDate), и сравнение с итогом честное.
    value: readTomlConfig(text, filePath).value,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    filePath,
  };

  try {
    for (const edit of edits) {
      if (edit.op === 'set') applySet(state, edit);
      else if (edit.op === 'remove') applyRemove(state, edit);
      else applyRemoveTable(state, edit);
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'layout') {
      throw new Error(
        `Internal error: could not map the layout of ${filePath}. Nothing was written — ` +
          `please report this at ${ISSUES_URL}`,
      );
    }
    throw err;
  }

  if (state.text.length > 0 && !state.text.endsWith('\n')) state.text += state.eol;
  assertOnlyIntendedChanges(state.text, state.value, filePath);
  return bom + state.text;
}
