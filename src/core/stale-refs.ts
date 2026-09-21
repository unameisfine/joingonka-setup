/**
 * Ссылки на модели, которых в сети больше нет, — ВНЕ каталога провайдера.
 *
 * ★ Зачем отдельный шаг. Каталог своего провайдера установщик всегда заменяет
 * целиком, дефолт сбрасывает, если тот указывал на убранную модель. Но модель
 * упоминается в конфиге не только там: запасные модели, модель отдельного
 * агента, «малая» модель для заголовков. Сценарий, который это закрывает: Kimi
 * K2.6 ушла из сети (11.09.2026), человек переустанавливает конфиг, видит
 * «Verified» — а его агент `plan` по-прежнему закреплён за
 * `joingonka/moonshotai/Kimi-K2.6` и на каждый запрос получает отказ.
 *
 * Правило одно для всех адаптеров: трогаем только ссылки на СВОЙ провайдер и
 * только те, чьей модели нет в каталоге (`isStaleProviderModelRef`). Чужие
 * провайдеры и актуальные наши модели не меняются никогда.
 */
import type { JsonEdit } from './json-config.js';
import { asObject } from './json-shape.js';
import { isStaleProviderModelRef, type JsonObject } from './merge.js';

/**
 * Строка для пользователя о вычищенных ссылках; null — чистить было нечего
 * (тогда и сообщать не о чем).
 */
export function staleRefsNote(count: number): string | null {
  if (count <= 0) return null;
  const refs = count === 1 ? '1 reference' : `${count} references`;
  return `Cleaned up ${refs} to models that are no longer served by the Gonka network.`;
}

/**
 * Разделы opencode-формата, где у записи есть своё поле `model`
 * (строка `<provider>/<model>`). Сверено 21.09.2026 по схеме конфига —
 * packages/core/src/v1/config/{config,agent,command}.ts в
 * github.com/anomalyco/opencode (ветка dev) и тем же файлам форка
 * github.com/Kilo-Org/kilocode (main):
 *   agent.<имя>.model   — модель агента (https://opencode.ai/docs/agents);
 *   mode.<имя>.model    — прежнее имя раздела `agent` (@deprecated, но читается);
 *   command.<имя>.model — модель пользовательской команды.
 */
const OPENCODE_MODEL_SECTIONS = ['agent', 'mode', 'command'] as const;

/**
 * Правки opencode-формата (opencode и Kilo): наши устаревшие ссылки в
 * `small_model` и в разделах OPENCODE_MODEL_SECTIONS заменяются на
 * `replacement`. Top-level `model` сюда не входит — им занимается адаптер.
 *
 * `small_model` заменяем, а не удаляем: человек осознанно отдал короткие задачи
 * (заголовки сессий) нашей модели, и после чистки так и должно остаться.
 */
export function opencodeStaleRefEdits(
  existing: JsonObject,
  providerId: string,
  canonicalIds: readonly string[],
  replacement: string,
): JsonEdit[] {
  const edits: JsonEdit[] = [];
  const isStale = (ref: unknown) => isStaleProviderModelRef(ref, providerId, canonicalIds);

  if (isStale(existing.small_model)) {
    edits.push({ path: ['small_model'], value: replacement });
  }

  for (const section of OPENCODE_MODEL_SECTIONS) {
    const entries = asObject(existing[section]);
    if (!entries) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (isStale(asObject(entry)?.model)) {
        edits.push({ path: [section, name, 'model'], value: replacement });
      }
    }
  }

  return edits;
}
