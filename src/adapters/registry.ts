/**
 * Реестр адаптеров — единая точка регистрации поддерживаемых инструментов.
 *
 * Оркестратор (run.ts) и CLI обращаются к инструментам только через этот
 * реестр: getAdapter(id) для выбранного инструмента, listTools() для меню,
 * toolIds() для описания `--tool`. Добавить инструмент = импортировать его
 * адаптер и дописать в `adapters` (и в тип ToolId).
 *
 * ★ Реестр — ЕДИНСТВЕННЫЙ источник списка инструментов. До 0.5.0 id были
 * продублированы руками в cli.ts (описание `--tool`, «15 tools supported»), в
 * README и в package.json — и разъезжались при каждом добавлении. Теперь cli.ts
 * берёт список и число отсюда, а README и package.json сверяет с реестром гейт
 * src/release-guard.test.ts.
 */
import type { Adapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import { openclawAdapter } from './openclaw.js';
import { hermesAdapter } from './hermes.js';
import { piAdapter } from './pi.js';
import { ompAdapter } from './omp.js';
import { cursorAdapter } from './cursor.js';
import { clineAdapter } from './cline.js';
import { kiloAdapter } from './kilo.js';
import { gooseAdapter } from './goose.js';
import { crushAdapter } from './crush.js';
import { qwenCodeAdapter } from './qwen-code.js';
import { kimiCodeAdapter } from './kimi-code.js';
import { droidAdapter } from './droid.js';
import { zedAdapter } from './zed.js';
import { aiderAdapter } from './aider.js';
import { copilotByokAdapter } from './copilot-byok.js';
import { jetbrainsAdapter } from './jetbrains.js';
import { zooAdapter } from './zoo.js';
import { mimoCodeAdapter } from './mimo-code.js';
import { minimaxCodeAdapter } from './minimax-code.js';
import { zcodeAdapter } from './zcode.js';
import { continueAdapter } from './continue.js';
import { rooAdapter } from './roo.js';

/** Идентификаторы поддерживаемых инструментов. */
export type ToolId =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'pi'
  | 'omp'
  | 'cursor'
  | 'cline'
  | 'kilo'
  | 'goose'
  | 'crush'
  | 'qwen-code'
  | 'kimi-code'
  | 'droid'
  | 'zed'
  | 'aider'
  | 'copilot-byok'
  | 'jetbrains'
  | 'zoo'
  | 'mimo-code'
  | 'minimax-code'
  | 'zcode'
  | 'continue'
  | 'roo';

/**
 * Карта id → адаптер.
 *
 * ★ Порядок ключей — это порядок интерактивного меню (listTools) и списка в
 * `--help`: сначала самые ходовые кодовые агенты, затем остальные; в конце —
 * то, что больше не развивается (Continue) и закрыто (Roo Code): человек,
 * листающий меню, не должен натыкаться на закрытый продукт раньше живых.
 */
export const adapters: Record<ToolId, Adapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  openclaw: openclawAdapter,
  hermes: hermesAdapter,
  pi: piAdapter,
  omp: ompAdapter,
  cursor: cursorAdapter,
  cline: clineAdapter,
  kilo: kiloAdapter,
  goose: gooseAdapter,
  crush: crushAdapter,
  'qwen-code': qwenCodeAdapter,
  'kimi-code': kimiCodeAdapter,
  droid: droidAdapter,
  zed: zedAdapter,
  aider: aiderAdapter,
  'copilot-byok': copilotByokAdapter,
  jetbrains: jetbrainsAdapter,
  zoo: zooAdapter,
  'mimo-code': mimoCodeAdapter,
  'minimax-code': minimaxCodeAdapter,
  zcode: zcodeAdapter,
  continue: continueAdapter,
  roo: rooAdapter,
};

/**
 * Возвращает адаптер по id или undefined, если id неизвестен.
 * Вызывающий код сам решает, как реагировать на undefined
 * (CLI — внятная ошибка со списком допустимых значений).
 *
 * Только СОБСТВЕННЫЕ ключи карты: `adapters['constructor']` по цепочке
 * прототипов отдал бы функцию, и `--tool constructor` упал бы не с «Unknown
 * tool», а с «adapter.apply is not a function».
 */
export function getAdapter(id: string): Adapter | undefined {
  return Object.hasOwn(adapters, id) ? adapters[id as ToolId] : undefined;
}

/** Id всех инструментов в порядке меню — для описания `--tool` и сообщений. */
export function toolIds(): ToolId[] {
  return Object.keys(adapters) as ToolId[];
}

/**
 * Id инструментов с проектным конфигом (`--scope local`) — для текста отказа в
 * оркестраторе: перечень считается, а не вписывается руками.
 */
export function localScopeToolIds(): ToolId[] {
  return toolIds().filter((id) => adapters[id].supportsLocalScope === true);
}

/** Список инструментов для меню выбора: { value, name }. */
export function listTools(): Array<{ value: ToolId; name: string }> {
  return toolIds().map((id) => ({
    value: id,
    name: adapters[id].label,
  }));
}
