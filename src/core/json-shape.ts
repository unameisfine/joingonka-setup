/**
 * Безопасное чтение значений из РАЗОБРАННОГО конфига пользователя.
 *
 * Конфиг инструмента — чужой файл: на месте объекта может стоять строка, на месте
 * строки — число, на месте списка — что угодно. Адаптеры не вправе ни падать на
 * этом с TypeError, ни принимать мусор за значение. До второй части 0.5.0 эти
 * три-четыре строки жили копиями в каждом адаптере (asObject — в девяти файлах):
 * авторам новых адаптеров было запрещено заводить общие модули.
 */
import type { JsonObject } from './merge.js';

/** Вложенный plain-объект либо undefined (массив, null и примитивы — не объект). */
export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Непустая строка БЕЗ пробелов по краям либо undefined — для значений, которые
 * сравниваются по смыслу (адрес шлюза, тип авторизации, id модели).
 */
export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Непустая строка КАК ЕСТЬ либо undefined — для значений, которые возвращаются
 * пользователю дословно или служат ключом в его же файле (алиас модели в TOML):
 * подрезанная строка уже не совпала бы с тем, что записано на диске.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Записи списка по их идентификатору: `[{ id: 'a', … }, …]` → Map('a' → запись).
 * Не-список даёт пустую карту, записи без строкового идентификатора пропускаются;
 * при повторе идентификатора остаётся ПЕРВАЯ запись — так же разрешают дубли сами
 * инструменты.
 */
export function entriesById(list: unknown, key = 'id'): Map<string, JsonObject> {
  const byId = new Map<string, JsonObject>();
  if (!Array.isArray(list)) return byId;
  for (const item of list) {
    const entry = asObject(item);
    const id = entry?.[key];
    if (entry && typeof id === 'string' && !byId.has(id)) byId.set(id, entry);
  }
  return byId;
}
