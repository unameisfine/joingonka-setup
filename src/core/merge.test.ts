/**
 * Тесты merge.ts — слияния JSON-конфигов.
 *
 * Ключевые инварианты:
 * - mergeJson: сохраняет чужие top-level поля И чужие env-ключи,
 *   перезаписывает только переданные в patch (deep-merge ТОЛЬКО по env).
 * - deepMergeJson: рекурсивный merge вложенных объектов (для OpenClaw —
 *   глубокая структура models.providers / agents.defaults), массивы и
 *   примитивы из patch заменяют значение целиком.
 * - upsertById: upsert элемента массива по полю id (обновляет существующий,
 *   добавляет новый; не плодит дубли при повторном вызове).
 */
import { describe, it, expect } from 'vitest';
import {
  mergeJson,
  deepMergeJson,
  upsertById,
  isStaleProviderModelRef,
  pruneStaleProviderAliases,
} from './merge.js';

describe('mergeJson', () => {
  it('preserves foreign top-level fields', () => {
    const existing = { theme: 'dark', hooks: { PreToolUse: ['foo'] } };
    const result = mergeJson(existing, { env: { ANTHROPIC_BASE_URL: 'x' } });
    expect(result.theme).toBe('dark');
    expect(result.hooks).toEqual({ PreToolUse: ['foo'] });
  });

  it('preserves foreign env keys and overwrites only ours', () => {
    const existing = { env: { CUSTOM_VAR: 'keep-me', ANTHROPIC_AUTH_TOKEN: 'old' } };
    const result = mergeJson(existing, {
      env: { ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_BASE_URL: 'url' },
    });
    const env = result.env as Record<string, string>;
    expect(env.CUSTOM_VAR).toBe('keep-me');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('new');
    expect(env.ANTHROPIC_BASE_URL).toBe('url');
  });

  it('works when existing has no env block', () => {
    const result = mergeJson({ other: 1 }, { env: { A: 'b' } });
    expect(result.other).toBe(1);
    expect((result.env as Record<string, string>).A).toBe('b');
  });

  it('treats a non-object existing as empty', () => {
    // null / массив / примитив не должны ломать merge
    const result = mergeJson(null, { env: { A: 'b' } });
    expect((result.env as Record<string, string>).A).toBe('b');
  });

  it('deep-merges only the env block, replacing other patch keys wholesale', () => {
    const existing = { permissions: { allow: ['Bash'] } };
    const result = mergeJson(existing, { permissions: { allow: ['Read'] } });
    // permissions из patch заменяет целиком (не env — без глубокого merge)
    expect(result.permissions).toEqual({ allow: ['Read'] });
  });
});

describe('deepMergeJson', () => {
  it('treats a non-object base as empty and returns the patch shape', () => {
    expect(deepMergeJson(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeJson(42 as unknown, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeJson([1, 2] as unknown, { a: 1 })).toEqual({ a: 1 });
  });

  it('recursively merges nested objects, preserving foreign branches', () => {
    const base = {
      models: { providers: { openai: { baseUrl: 'https://api.openai.com' } } },
      other: { keep: true },
    };
    const patch = {
      models: { providers: { gonka: { baseUrl: 'https://gate.joingonka.ai' } } },
    };
    const result = deepMergeJson(base, patch);
    // Чужой провайдер сохранён
    expect(result).toMatchObject({
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com' },
          gonka: { baseUrl: 'https://gate.joingonka.ai' },
        },
      },
      other: { keep: true },
    });
  });

  it('overwrites scalar values from patch', () => {
    const result = deepMergeJson({ a: { x: 1, y: 2 } }, { a: { y: 99 } });
    expect(result).toEqual({ a: { x: 1, y: 99 } });
  });

  it('replaces arrays wholesale (does not concatenate)', () => {
    const result = deepMergeJson({ list: [1, 2, 3] }, { list: [9] });
    expect(result.list).toEqual([9]);
  });

  it('replaces an object with a scalar when patch is a scalar', () => {
    const result = deepMergeJson({ a: { nested: true } }, { a: 'scalar' });
    expect(result.a).toBe('scalar');
  });

  it('does not mutate the base object', () => {
    const base = { a: { x: 1 } };
    const result = deepMergeJson(base, { a: { y: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
  });

  it('keeps an existing nested value when patch sets it to undefined is N/A — undefined keys are merged through', () => {
    // patch с явным undefined не должен затирать существующее значение
    const result = deepMergeJson({ a: { keep: 1 } }, { a: { keep: undefined } } as unknown as Record<string, unknown>);
    expect((result.a as Record<string, unknown>).keep).toBe(1);
  });
});

describe('upsertById', () => {
  it('appends a new item when id is absent', () => {
    const arr = [{ id: 'a', v: 1 }];
    const result = upsertById(arr, { id: 'b', v: 2 });
    expect(result).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
  });

  it('updates an existing item in place by id (no duplicates)', () => {
    const arr = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    const result = upsertById(arr, { id: 'a', v: 99, extra: 'new' });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'a', v: 99, extra: 'new' });
    expect(result[1]).toEqual({ id: 'b', v: 2 });
  });

  it('preserves unknown fields of the existing entry on update', () => {
    const arr = [{ id: 'a', mine: 'old', userField: 'keep' }];
    const result = upsertById(arr, { id: 'a', mine: 'new' });
    // Чужое поле userField сохраняется, наше mine обновляется
    expect(result[0]).toEqual({ id: 'a', mine: 'new', userField: 'keep' });
  });

  it('is idempotent — upserting the same item twice yields a single entry', () => {
    const item = { id: 'a', v: 1 };
    const once = upsertById([], item);
    const twice = upsertById(once, item);
    expect(twice).toEqual([{ id: 'a', v: 1 }]);
  });

  it('does not mutate the source array', () => {
    const arr = [{ id: 'a', v: 1 }];
    upsertById(arr, { id: 'a', v: 2 });
    expect(arr).toEqual([{ id: 'a', v: 1 }]);
  });

  it('skips non-object entries already in the array (keeps them untouched)', () => {
    const arr = [42 as unknown, { id: 'a', v: 1 }];
    const result = upsertById(arr, { id: 'a', v: 2 });
    expect(result[0]).toBe(42);
    expect(result[1]).toEqual({ id: 'a', v: 2 });
  });
});

describe('isStaleProviderModelRef', () => {
  const canonical = ['moonshotai/Kimi-K2.6', 'MiniMaxAI/MiniMax-M2.7'];

  it('true для НАШЕЙ убранной модели (вне каталога)', () => {
    expect(
      isStaleProviderModelRef('gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'gonka', canonical),
    ).toBe(true);
  });
  it('false для актуальной нашей модели (modelId с / сохраняется целиком)', () => {
    expect(isStaleProviderModelRef('gonka/moonshotai/Kimi-K2.6', 'gonka', canonical)).toBe(false);
  });
  it('false для ЧУЖОГО провайдера (не наш префикс)', () => {
    expect(isStaleProviderModelRef('openai/gpt-5.4', 'gonka', canonical)).toBe(false);
  });
  it('false для не-строки', () => {
    expect(isStaleProviderModelRef(undefined, 'gonka', canonical)).toBe(false);
    expect(isStaleProviderModelRef(123, 'gonka', canonical)).toBe(false);
  });
});

describe('pruneStaleProviderAliases', () => {
  const canonical = ['moonshotai/Kimi-K2.6', 'MiniMaxAI/MiniMax-M2.7'];

  it('убирает НАШ устаревший алиас, оставляет чужой и актуальный наш', () => {
    const aliases = {
      'gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { alias: 'qwen' },
      'gonka/moonshotai/Kimi-K2.6': { alias: 'kimi' },
      'openai/gpt-5.4': { alias: 'gpt' },
    };
    const out = pruneStaleProviderAliases(aliases, 'gonka', canonical);
    expect(out['gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toBeUndefined();
    expect(out['gonka/moonshotai/Kimi-K2.6']).toEqual({ alias: 'kimi' });
    expect(out['openai/gpt-5.4']).toEqual({ alias: 'gpt' });
  });
  it('не мутирует исходный объект', () => {
    const aliases = { 'gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': { alias: 'q' } };
    pruneStaleProviderAliases(aliases, 'gonka', canonical);
    expect(aliases['gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8']).toEqual({ alias: 'q' });
  });
});
