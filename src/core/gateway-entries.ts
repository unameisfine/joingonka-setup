/**
 * Наши записи в ОБЩЕМ массиве моделей инструмента.
 *
 * У части инструментов (Qwen Code — `modelProviders.openai[]`, Factory Droid —
 * `customModels[]`) нет отдельного блока провайдера: модели всех шлюзов лежат
 * одним списком, и запись сама несёт адрес шлюза. Отсюда два общих правила:
 *
 *   1. «Наша» запись — та, чей `baseUrl` указывает на наш шлюз (без учёта регистра
 *      и хвостовых `/`). Имя модели для этого не годится: HF-подобные id
 *      (`deepseek-ai/…`) продают и другие шлюзы.
 *   2. Правим ПОЭЛЕМЕНТНО: наши записи заменяются на месте, недостающие
 *      дописываются в конец — значения чужих записей и комментарии целы (меняются
 *      только отступы элемента, за которым идёт вставка). Удалять элемент по
 *      индексу нельзя: jsonc-parser 3.3.1 портит однострочные массивы и съедает
 *      комментарий за элементом (core/json-config.ts). Поэтому редкий случай
 *      «наших записей БОЛЬШЕ, чем моделей в каталоге» решается заменой массива
 *      целиком: значения чужих записей сохраняются, комментарии внутри массива — нет.
 *
 * До второй части 0.5.0 это жило двумя одинаковыми копиями в qwen-code.ts и droid.ts.
 */
import type { JSONPath } from 'jsonc-parser';
import { BASE_URL_OPENAI } from '../constants.js';
import type { JsonEdit } from './json-config.js';
import { asObject, asText } from './json-shape.js';
import type { JsonObject } from './merge.js';

/** Адрес шлюза для сравнения: без хвостовых `/`, без регистра. */
export function gatewayUrlKey(value: unknown): string | undefined {
  const text = asText(value);
  return text === undefined ? undefined : text.replace(/\/+$/, '').toLowerCase();
}

/** Наш адрес в той же нормализации. */
export const OUR_GATEWAY_URL_KEY = gatewayUrlKey(BASE_URL_OPENAI)!;

/** true — запись ведёт на наш шлюз (значит, ею управляет установщик). */
export function isGatewayEntry(entry: unknown): boolean {
  return gatewayUrlKey(asObject(entry)?.baseUrl) === OUR_GATEWAY_URL_KEY;
}

/**
 * Правки общего массива по пути `base` (стратегия — в шапке модуля).
 *
 * @param list    нынешнее значение по этому пути (не массив → массив создаётся);
 * @param entries наши записи в том виде, в каком они должны оказаться в файле.
 */
export function planSharedArrayEdits(
  base: JSONPath,
  list: unknown,
  entries: readonly JsonObject[],
): JsonEdit[] {
  if (!Array.isArray(list)) return [{ path: base, value: entries }];

  const ourIndexes = list.flatMap((entry, index) => (isGatewayEntry(entry) ? [index] : []));

  if (ourIndexes.length > entries.length) {
    let next = 0;
    const rebuilt = list.flatMap((entry) => {
      if (!isGatewayEntry(entry)) return [entry];
      return next < entries.length ? [entries[next++]] : [];
    });
    return [{ path: base, value: rebuilt }];
  }

  return entries.map((entry, position) => ({
    // Индекс -1 у jsonc-parser — «дописать в конец массива».
    path: [...base, position < ourIndexes.length ? ourIndexes[position]! : -1],
    value: entry,
  }));
}
