/**
 * Безопасное чтение и ТОЧЕЧНАЯ правка JSON/JSONC-конфигов инструментов.
 *
 * ★ Зачем модуль появился (инцидент-класс, аудит 19.09.2026).
 * Адаптеры openclaw/kilo/opencode читали конфиг через `JSON.parse`, а при
 * исключении молча стартовали с пустого объекта `{}` и записывали результат
 * поверх файла. Но конфиги этих инструментов — JSONC/JSON5: комментарий или
 * висячая запятая (законные для них!) ломали `JSON.parse`, и пользователь терял
 * ВСЮ конфигурацию — MCP-серверы, чужих провайдеров, каналы, кейбинды.
 * Оставался только `.bak`, о котором ещё надо догадаться.
 *
 * Здесь два правила, которые это закрывают:
 *   1. читаем через jsonc-parser (комментарии и висячие запятые — норма);
 *      разобрать нельзя → ОТКАЗ (исключение) и НИ ОДНОЙ записи на диск;
 *   2. пишем не «сериализацию объекта», а точечные правки по путям
 *      (modify + applyEdits): чужие ключи, форматирование и комментарии целы.
 *
 * Тот же приём с 0.4.0 работает в адаптере Zed — там он появился раньше,
 * потому что settings.json редактора почти всегда с комментариями.
 */
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import type { JSONPath, ParseError } from 'jsonc-parser';
import type { JsonObject } from './merge.js';

/** Отступы правок — общий стиль конфигов инструментов (2 пробела, LF). */
export const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/** Разобранный конфиг: исходный текст для правок + значение для решений. */
export interface JsonConfigDoc {
  /**
   * ИСХОДНЫЙ текст файла (или '{}' для нового). Правки применяются к нему,
   * поэтому комментарии и форматирование пользователя сохраняются.
   */
  text: string;
  /** Разобранное значение — только для чтения: «что уже задано у пользователя». */
  value: JsonObject;
}

/** Номер строки (1-based) по смещению в тексте — для понятного сообщения об ошибке. */
function lineAt(raw: string, offset: number): number {
  return raw.slice(0, offset).split('\n').length;
}

/**
 * Читает конфиг инструмента. `raw === null` (файла нет) или пустой файл →
 * пустой документ.
 *
 * Бросает исключение, если файл нельзя разобрать или в корне не объект.
 * Вызывающий адаптер в этот момент ещё НИЧЕГО не записал и не должен —
 * сообщение объясняет пользователю, что делать.
 */
export function readJsonConfig(raw: string | null, filePath: string): JsonConfigDoc {
  if (raw == null || raw.trim() === '') {
    return { text: '{}', value: {} };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `${filePath} is not valid JSON/JSONC: ${printParseErrorCode(first.error)} ` +
        `at line ${lineAt(raw, first.offset)}. Nothing was written — fix the file ` +
        `(or move it aside) and run the installer again.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${filePath} does not contain a JSON object at the top level. ` +
        `Nothing was written — fix the file (or move it aside) and run the installer again.`,
    );
  }

  return { text: raw, value: parsed as JsonObject };
}

/** Одна правка: путь внутри документа и новое значение (undefined = удалить ключ). */
export interface JsonEdit {
  path: JSONPath;
  value: unknown;
}

/** Общая концовка отказа — та же, что у readJsonConfig. */
const REFUSAL_HINT =
  'Nothing was written — fix the file (or move it aside) and run the installer again.';

/** Как назвать человеку тип узла, занявшего чужое место. */
const NODE_TYPE_LABEL: Readonly<Record<string, string>> = {
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean',
  null: 'null',
  array: 'an array',
  object: 'an object',
};

/**
 * Ищет узел, из-за которого правку нельзя применить: самый глубокий
 * СУЩЕСТВУЮЩИЙ предок на пути, который не может вместить следующий сегмент
 * (строковому сегменту нужен объект, числовому — массив). Отсутствующих предков
 * jsonc-parser создаёт сам, они правке не мешают.
 */
function findBlockingNode(
  text: string,
  path: JSONPath,
): { key: string; type: string; needed: 'array' | 'object' } | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root) return undefined;

  for (let depth = 1; depth < path.length; depth += 1) {
    const node = findNodeAtLocation(root, path.slice(0, depth));
    if (!node) return undefined;
    const needed = typeof path[depth] === 'number' ? 'array' : 'object';
    if (node.type !== needed) {
      return { key: path.slice(0, depth).join(' → '), type: node.type, needed };
    }
  }
  return undefined;
}

/**
 * Применяет правки по очереди к тексту документа и гарантирует перевод строки
 * в конце. Промежуточные значения не пересобираются: каждая правка работает по
 * уже изменённому тексту, поэтому порядок правок значим.
 *
 * ★ Вызывать ДО бэкапа и записи. Функция может отказать (исключением), и к
 * этому моменту диск обязан быть нетронут: до 0.4.5 адаптеры сначала делали
 * `.bak`, потом считали правки, и отказ оставлял после себя лишний бэкап при
 * несостоявшейся установке. Порядок в адаптере: прочитать → посчитать итоговый
 * текст → backup → atomicWrite.
 *
 * Два отказа:
 *   1. Неожиданная форма узла. Правке `provider.joingonka.npm` нужен ОБЪЕКТ в
 *      `provider`; если там примитив (`"provider": "x"`, `"env": 5`),
 *      jsonc-parser бросает сырое «Can not add index to parent of type string».
 *      Переводим в сообщение стиля readJsonConfig: файл, ключ, «Nothing was
 *      written». Чужое значение не затираем — человек мог положить его намеренно.
 *   2. Результат ОБЯЗАН разбираться. Портить текст умеет сама библиотека:
 *      jsonc-parser 3.3.1, удаляя последний элемент однострочного массива
 *      (`modify(text, [..., i], undefined)`), отдаёт `"x""]` — невалидный JSON,
 *      который ушёл бы на диск поверх рабочего конфига. Поэтому элементы
 *      массивов адаптеры не удаляют по индексу, а заменяют массив целиком; эта
 *      же проверка страхует от случаев, которых мы ещё не знаем.
 *
 * @param filePath путь к файлу — только для сообщения об отказе. В сигнатуре он
 *   ОБЯЗАТЕЛЕН: пока параметр был необязательным, пять новых адаптеров его не
 *   передали, и в отказе вместо пути стояло безликое «The config file:» — человек
 *   с тремя конфигами не понимал, какой из них чинить. Теперь забытый путь ловит
 *   `tsc`. Запасной текст ниже — только для вызова из нетипизированного кода.
 */
export function applyJsonEdits(
  text: string,
  edits: readonly JsonEdit[],
  filePath: string,
): string {
  const where = filePath || 'The config file';
  let out = text;
  for (const edit of edits) {
    try {
      out = applyEdits(out, modify(out, edit.path, edit.value, { formattingOptions: FORMATTING }));
    } catch (err) {
      const blocking = findBlockingNode(out, edit.path);
      throw new Error(
        blocking
          ? `${where}: "${blocking.key}" is ${NODE_TYPE_LABEL[blocking.type] ?? blocking.type}, ` +
              `but the installer needs ${NODE_TYPE_LABEL[blocking.needed]} there to add its ` +
              `settings. ${REFUSAL_HINT}`
          : `${where}: cannot apply the change at "${edit.path.join(' → ')}" ` +
              `(${err instanceof Error ? err.message : String(err)}). ${REFUSAL_HINT}`,
      );
    }
  }
  if (!out.endsWith('\n')) {
    out += '\n';
  }

  const errors: ParseError[] = [];
  parseJsonc(out, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(
      `Internal error: the edited ${filePath || 'config'} would no longer be valid JSON/JSONC ` +
        `(${printParseErrorCode(errors[0]!.error)}). Nothing was written — please report this at ` +
        'https://github.com/unameisfine/joingonka-setup/issues',
    );
  }
  return out;
}
