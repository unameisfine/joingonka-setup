/** Тесты core/json-shape — безопасного чтения значений из чужого конфига. */
import { describe, it, expect } from 'vitest';
import { asObject, asText, entriesById, nonEmptyString } from './json-shape.js';

describe('asObject', () => {
  it('returns plain objects and nothing else', () => {
    const obj = { a: 1 };
    expect(asObject(obj)).toBe(obj);
    for (const value of [undefined, null, 'x', 5, true, [], [{ a: 1 }]]) {
      expect(asObject(value)).toBeUndefined();
    }
  });

  it('makes a chain of lookups safe on any shape', () => {
    const config: unknown = { provider: 'oops' };
    expect(asObject(asObject(asObject(config)?.provider)?.joingonka)?.options).toBeUndefined();
  });
});

describe('asText / nonEmptyString', () => {
  it('accept only non-empty strings', () => {
    for (const value of [undefined, null, '', '   ', 5, {}, []]) {
      expect(asText(value)).toBeUndefined();
      expect(nonEmptyString(value)).toBeUndefined();
    }
  });

  it('differ in trimming: asText compares by meaning, nonEmptyString keeps the text as written', () => {
    expect(asText('  openai \n')).toBe('openai');
    expect(nonEmptyString('  openai \n')).toBe('  openai \n');
  });
});

describe('entriesById', () => {
  it('indexes list entries by their id', () => {
    const list = [{ id: 'a', cost: 1 }, { id: 'b', cost: 2 }];
    const byId = entriesById(list);
    expect([...byId.keys()]).toEqual(['a', 'b']);
    expect(byId.get('b')).toBe(list[1]);
  });

  it('supports another key and keeps the FIRST of two duplicates', () => {
    const byModel = entriesById([{ model: 'm', n: 1 }, { model: 'm', n: 2 }], 'model');
    expect(byModel.get('m')).toEqual({ model: 'm', n: 1 });
  });

  it('survives junk: not a list, non-objects, missing or non-string ids', () => {
    expect(entriesById(undefined).size).toBe(0);
    expect(entriesById({ id: 'a' }).size).toBe(0);
    expect([...entriesById(['x', null, 5, { id: 7 }, { name: 'n' }, { id: 'ok' }]).keys()]).toEqual(['ok']);
  });
});
