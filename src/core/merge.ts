/**
 * Слияния JSON-конфигов.
 *
 * Общий принцип всех merge: НЕ разрушать чужие поля. Пользователь мог
 * настроить инструмент под себя (хуки, лимиты, другие провайдеры) — мы
 * трогаем только те ключи, которые относятся к переключению на JoinGonka
 * Gateway.
 */

/** Произвольный JSON-объект конфига (частичная форма — чужие поля сохраняются). */
export type JsonObject = Record<string, unknown>;

/** true для plain-объекта (не null, не массив). */
function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Слияние JSON-конфигов на ОДИН уровень вложенности по `env`.
 *
 * - Все top-level поля existing сохраняются.
 * - patch перезаписывает совпадающие top-level ключи ЦЕЛИКОМ, КРОМЕ `env`:
 *   блок `env` сливается по ключам (deep-merge на один уровень), чтобы
 *   не потерять чужие переменные окружения (CUSTOM_VAR, EDITOR и т.п.).
 *
 * Глубокий merge ограничен `env` намеренно: для Claude Code это единственный
 * вложенный объект, куда мы дописываем свои ключи рядом с пользовательскими.
 * Для произвольно-вложенных схем (OpenClaw) используется deepMergeJson.
 *
 * @param existing текущий объект конфига (null/массив/примитив → пустой)
 * @param patch    наши поля для записи
 */
export function mergeJson(existing: unknown, patch: JsonObject): JsonObject {
  // Защита от null / массивов / примитивов — конфиг должен быть объектом
  const base: JsonObject = isPlainObject(existing) ? existing : {};

  const merged: JsonObject = { ...base, ...patch };

  // env сливаем по ключам, а не заменяем целиком
  if (isPlainObject(patch.env)) {
    const existingEnv = isPlainObject(base.env) ? base.env : {};
    merged.env = { ...existingEnv, ...patch.env };
  }

  return merged;
}

/**
 * Рекурсивный merge двух JSON-объектов (immutable: base не мутируется).
 *
 * Правила:
 * - оба значения по ключу — plain-объекты → сливаем рекурсивно;
 * - значение из patch === undefined → НЕ затирает существующее (пропускаем);
 * - иначе значение из patch заменяет значение base целиком (массивы и
 *   примитивы НЕ сливаются — для конфигов «заменить список» предсказуемее,
 *   чем конкатенация дублей; точечный upsert элементов делает upsertById).
 *
 * Применяется к глубоко-вложенным схемам (OpenClaw: models.providers.*,
 * agents.defaults.*), где чужие ветки (другой провайдер, чужие алиасы)
 * должны пережить наш upsert.
 *
 * @param base  текущий объект (null/массив/примитив → пустой объект)
 * @param patch объект с нашими полями
 */
export function deepMergeJson(base: unknown, patch: JsonObject): JsonObject {
  const out: JsonObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      // Явный undefined в patch не должен затирать существующее значение
      continue;
    }
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      out[key] = deepMergeJson(baseValue, patchValue);
    } else {
      out[key] = patchValue;
    }
  }

  return out;
}

/**
 * Upsert элемента в массив по полю `id` (immutable: исходный массив не
 * мутируется, возвращается новая копия).
 *
 * - запись с таким `id` есть → обновляется (поля item накладываются поверх,
 *   чужие поля существующей записи сохраняются — shallow-merge);
 * - записи нет → item добавляется в конец.
 *
 * Идемпотентность: повторный upsert той же записи не плодит дубликаты.
 * Не-объектные элементы исходного массива пропускаются нетронутыми.
 *
 * @param array исходный массив записей (произвольных)
 * @param item  запись с обязательным полем id
 */
export function upsertById(array: unknown[], item: JsonObject & { id: string }): unknown[] {
  const out = [...array];
  const idx = out.findIndex((entry) => isPlainObject(entry) && entry.id === item.id);
  if (idx === -1) {
    out.push({ ...item });
    return out;
  }
  const existing = out[idx] as JsonObject;
  out[idx] = { ...existing, ...item };
  return out;
}
