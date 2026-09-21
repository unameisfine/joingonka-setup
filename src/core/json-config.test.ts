/**
 * Тесты json-config.ts — безопасного чтения и точечной правки JSON/JSONC.
 *
 * Главный инвариант: конфиг пользователя НИКОГДА не теряется.
 * - комментарии и висячие запятые — законная форма (JSONC), читаются и переживают правку;
 * - чужие ключи, форматирование и комментарии остаются на месте (правка точечная);
 * - файл, который разобрать нельзя, приводит к ОТКАЗУ (исключению), а не к записи
 *   поверх: раньше адаптеры в этом случае стартовали с пустого объекта и уносили
 *   всю конфигурацию пользователя (MCP-серверы, каналы, чужие провайдеры).
 */
import { describe, it, expect } from 'vitest';
import { readJsonConfig, applyJsonEdits } from './json-config.js';

describe('readJsonConfig', () => {
  it('returns an empty document when the file does not exist', () => {
    const doc = readJsonConfig(null, '/tmp/absent.json');
    expect(doc.value).toEqual({});
    expect(doc.text).toBe('{}');
  });

  it('treats an empty file as an empty document', () => {
    const doc = readJsonConfig('   \n', '/tmp/empty.json');
    expect(doc.value).toEqual({});
  });

  it('reads JSONC with comments and trailing commas', () => {
    const raw = `{
  // мой любимый редактор
  "theme": "dark",
  "mcp": { "servers": ["local"], },
}`;
    const doc = readJsonConfig(raw, '/tmp/config.jsonc');
    expect(doc.value.theme).toBe('dark');
    expect(doc.text).toBe(raw);
  });

  it('throws with the file path and line number on broken syntax', () => {
    const raw = '{\n  "theme": "dark"\n  "missing": "comma"\n}';
    expect(() => readJsonConfig(raw, '/home/u/.config/kilo/kilo.jsonc')).toThrow(
      /kilo\.jsonc.*line 3/s,
    );
  });

  it('never suggests that anything was written when it refuses', () => {
    expect(() => readJsonConfig('{oops', '/tmp/broken.json')).toThrow(/Nothing was written/);
  });

  it('refuses a root that is not an object', () => {
    expect(() => readJsonConfig('[1, 2]', '/tmp/array.json')).toThrow(/object/i);
  });
});

describe('applyJsonEdits', () => {
  it('keeps comments, foreign keys and formatting', () => {
    const raw = `{
  // не трогать
  "theme": "dark",
  "mcp": { "servers": ["local"] }
}`;
    const out = applyJsonEdits(raw, [
      { path: ['provider', 'joingonka', 'baseURL'], value: 'https://gate.joingonka.ai/v1' },
    ]);
    expect(out).toContain('// не трогать');
    expect(out).toContain('"theme": "dark"');
    expect(out).toContain('"servers"');
    expect(JSON.parse(out.replace(/^\s*\/\/.*$/gm, '')).provider.joingonka.baseURL).toBe(
      'https://gate.joingonka.ai/v1',
    );
  });

  it('applies several edits in order and deletes on undefined', () => {
    const raw = '{\n  "model": "old",\n  "aliases": { "gonka/stale": { "alias": "x" } }\n}';
    const out = applyJsonEdits(raw, [
      { path: ['model'], value: 'gonka/new' },
      { path: ['aliases', 'gonka/stale'], value: undefined },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.model).toBe('gonka/new');
    expect(parsed.aliases).toEqual({});
  });

  it('ends the file with a newline', () => {
    const out = applyJsonEdits('{}', [{ path: ['a'], value: 1 }]);
    expect(out.endsWith('\n')).toBe(true);
  });
});
