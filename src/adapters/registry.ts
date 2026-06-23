/**
 * Реестр адаптеров — единая точка регистрации поддерживаемых инструментов.
 *
 * Оркестратор (run.ts) и CLI обращаются к инструментам только через этот
 * реестр: getAdapter(id) для выбранного инструмента, listTools() для меню.
 * Добавить инструмент = импортировать его адаптер и дописать в `adapters`.
 */
import type { Adapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { openclawAdapter } from './openclaw.js';
import { clineAdapter } from './cline.js';
import { opencodeAdapter } from './opencode.js';
import { aiderAdapter } from './aider.js';
import { kiloAdapter } from './kilo.js';
import { rooAdapter } from './roo.js';
import { continueAdapter } from './continue.js';

/** Идентификаторы поддерживаемых инструментов. */
export type ToolId =
  | 'claude-code'
  | 'openclaw'
  | 'cline'
  | 'opencode'
  | 'aider'
  | 'kilo'
  | 'roo'
  | 'continue';

/** Карта id → адаптер. */
export const adapters: Record<ToolId, Adapter> = {
  'claude-code': claudeCodeAdapter,
  openclaw: openclawAdapter,
  cline: clineAdapter,
  opencode: opencodeAdapter,
  aider: aiderAdapter,
  kilo: kiloAdapter,
  roo: rooAdapter,
  continue: continueAdapter,
};

/**
 * Возвращает адаптер по id или undefined, если id неизвестен.
 * Вызывающий код сам решает, как реагировать на undefined
 * (CLI — внятная ошибка со списком допустимых значений).
 */
export function getAdapter(id: string): Adapter | undefined {
  return adapters[id as ToolId];
}

/** Список инструментов для меню выбора: { value, name }. */
export function listTools(): Array<{ value: ToolId; name: string }> {
  return (Object.keys(adapters) as ToolId[]).map((id) => ({
    value: id,
    name: adapters[id].label,
  }));
}
