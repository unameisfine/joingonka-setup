/**
 * Тексты CLI, которые зависят от состава реестра адаптеров.
 *
 * ★ Зачем отдельный модуль. До 0.5.0 список id и число инструментов были вписаны
 * в cli.ts руками («15 tools supported», перечень в описании `--tool`) и
 * расходились с реестром при каждом добавлении адаптера. Теперь они считаются из
 * реестра, а сам модуль без побочных эффектов (cli.ts при импорте сразу разбирает
 * аргументы) — поэтому его можно проверить тестом.
 */
import { toolIds } from './adapters/registry.js';

/** Описание программы для `--help`: число инструментов — из реестра. */
export function programDescription(): string {
  return `Point an agentic AI tool at JoinGonka Gateway (${toolIds().length} tools supported)`;
}

/** Описание флага `--tool`: id в порядке меню, через ` | `. */
export function toolOptionDescription(): string {
  return `Tool: ${toolIds().join(' | ')}`;
}
