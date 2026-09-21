/**
 * Тесты реестра адаптеров — единственного источника списка инструментов.
 *
 * Реестр читают оркестратор (getAdapter), меню (listTools) и описание `--tool`
 * в CLI (toolIds); README и package.json сверяет с ним src/release-guard.test.ts.
 * Здесь — внутренняя согласованность самого реестра.
 */
import { describe, it, expect } from 'vitest';
import { adapters, getAdapter, listTools, toolIds } from './registry.js';

describe('registry', () => {
  it('registers every adapter under its own id', () => {
    // Ключ карты и `adapter.id` пишутся в разных файлах: разъедутся — и
    // `--tool <id>` поставит не тот инструмент, который назван в сообщениях.
    for (const [key, adapter] of Object.entries(adapters)) {
      expect(adapter.id, `registry key "${key}"`).toBe(key);
    }
  });

  it('knows the 25 tools of 0.5.0, including the ten added in it', () => {
    expect(toolIds()).toHaveLength(25);
    for (const id of [
      'zoo',
      'omp',
      'minimax-code',
      'goose',
      'mimo-code',
      'qwen-code',
      'droid',
      'crush',
      'codex',
      'kimi-code',
    ]) {
      expect(getAdapter(id), id).toBeDefined();
    }
  });

  it('declares a config format for every adapter, TOML included', () => {
    expect(getAdapter('codex')!.format).toBe('toml');
    expect(getAdapter('kimi-code')!.format).toBe('toml');
    for (const id of toolIds()) {
      expect(['json', 'yaml', 'toml', 'instructions']).toContain(adapters[id].format);
      // Инструкция не пишет файл — и наоборот: пишущий адаптер обязан назвать путь.
      const path = adapters[id].resolvePath('user');
      if (adapters[id].format === 'instructions') expect(path, id).toBeNull();
      else expect(path, id).toEqual(expect.any(String));
    }
  });

  it('keeps menu labels unique and non-empty', () => {
    const labels = listTools().map((t) => t.name);
    expect(labels.every((label) => label.trim() !== '')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('orders the menu: popular coding agents first, the discontinued Roo Code last', () => {
    const ids = listTools().map((t) => t.value);
    expect(ids.slice(0, 10)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'openclaw',
      'hermes',
      'pi',
      'omp',
      'cursor',
      'cline',
      'kilo',
    ]);
    expect(ids.at(-1)).toBe('roo');
    expect(listTools().at(-1)!.name).toMatch(/discontinued/i);
    // Преемник Roo стоит в меню раньше закрытого продукта.
    expect(ids.indexOf('zoo')).toBeLessThan(ids.indexOf('roo'));
  });

  it('returns undefined for unknown ids — including names inherited from Object', () => {
    expect(getAdapter('foo')).toBeUndefined();
    // Без проверки собственных ключей `--tool constructor` падал бы не с
    // «Unknown tool», а с «adapter.apply is not a function».
    expect(getAdapter('constructor')).toBeUndefined();
    expect(getAdapter('toString')).toBeUndefined();
    expect(getAdapter('__proto__')).toBeUndefined();
  });
});
