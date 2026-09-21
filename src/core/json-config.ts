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
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
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

/**
 * Применяет правки по очереди к тексту документа и гарантирует перевод строки
 * в конце. Промежуточные значения не пересобираются: каждая правка работает по
 * уже изменённому тексту, поэтому порядок правок значим.
 */
export function applyJsonEdits(text: string, edits: readonly JsonEdit[]): string {
  let out = text;
  for (const edit of edits) {
    out = applyEdits(out, modify(out, edit.path, edit.value, { formattingOptions: FORMATTING }));
  }
  if (!out.endsWith('\n')) {
    out += '\n';
  }
  return out;
}
