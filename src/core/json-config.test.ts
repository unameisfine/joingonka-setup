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
  const PATH = '/home/u/cfg.json';

  it('keeps comments, foreign keys and formatting', () => {
    const raw = `{
  // не трогать
  "theme": "dark",
  "mcp": { "servers": ["local"] }
}`;
    const out = applyJsonEdits(
      raw,
      [{ path: ['provider', 'joingonka', 'baseURL'], value: 'https://gate.joingonka.ai/v1' }],
      PATH,
    );
    expect(out).toContain('// не трогать');
    expect(out).toContain('"theme": "dark"');
    expect(out).toContain('"servers"');
    expect(JSON.parse(out.replace(/^\s*\/\/.*$/gm, '')).provider.joingonka.baseURL).toBe(
      'https://gate.joingonka.ai/v1',
    );
  });

  it('applies several edits in order and deletes on undefined', () => {
    const raw = '{\n  "model": "old",\n  "aliases": { "gonka/stale": { "alias": "x" } }\n}';
    const out = applyJsonEdits(
      raw,
      [
        { path: ['model'], value: 'gonka/new' },
        { path: ['aliases', 'gonka/stale'], value: undefined },
      ],
      PATH,
    );
    const parsed = JSON.parse(out);
    expect(parsed.model).toBe('gonka/new');
    expect(parsed.aliases).toEqual({});
  });

  it('ends the file with a newline', () => {
    const out = applyJsonEdits('{}', [{ path: ['a'], value: 1 }], PATH);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('refuses to hand back text that no longer parses', () => {
    // ★ Страховка от дефекта самой библиотеки. jsonc-parser 3.3.1 портит текст,
    // удаляя ПОСЛЕДНИЙ элемент однострочного массива: из ["x", "stale"] выходит
    // `"x""]`. Такой результат нельзя писать на диск поверх рабочего конфига.
    // Адаптеры обходят дефект (заменяют массив целиком), а эта проверка ловит
    // всё, чего мы ещё не знаем.
    expect(() =>
      applyJsonEdits(
        '{ "fallbacks": ["x", "stale"] }',
        [{ path: ['fallbacks', 1], value: undefined }],
        PATH,
      ),
    ).toThrow(/Internal error: the edited \/home\/u\/cfg\.json.*Nothing was written/s);
  });

  it('removes array items safely when the whole array is replaced', () => {
    const out = applyJsonEdits(
      '{ "fallbacks": ["x", "stale"] } // хвост',
      [{ path: ['fallbacks'], value: ['x'] }],
      PATH,
    );
    expect(out).toContain('// хвост');
    expect(JSON.parse(out.replace(/\/\/.*$/gm, '')).fallbacks).toEqual(['x']);
  });
});

describe('applyJsonEdits — неожиданная форма узла на пути правки', () => {
  // ★ Правка `provider.joingonka.npm` требует, чтобы `provider` был объектом. Если
  // там примитив (рукописный конфиг, чужой инструмент), jsonc-parser бросает
  // сырое «Can not add index to parent of type string». Человеку нужно другое:
  // какой файл, какой ключ, и что на диск ничего не попало.
  const FILE = '/home/u/.config/kilo/kilo.jsonc';

  it('names the file and the key, and says nothing was written', () => {
    expect(() =>
      applyJsonEdits('{ "provider": "x" }', [{ path: ['provider', 'joingonka', 'npm'], value: 'n' }], FILE),
    ).toThrow(/kilo\.jsonc.*"provider" is a string.*Nothing was written/s);
  });

  it('points at the deepest existing key that blocks the edit', () => {
    expect(() =>
      applyJsonEdits(
        '{ "provider": { "joingonka": 5 } }',
        [{ path: ['provider', 'joingonka', 'options', 'baseURL'], value: 'u' }],
        FILE,
      ),
    ).toThrow(/"provider → joingonka" is a number/);
  });

  it('treats null, booleans and arrays the same way', () => {
    const edit = [{ path: ['env', 'ANTHROPIC_MODEL'], value: 'm' }];
    expect(() => applyJsonEdits('{ "env": null }', edit, FILE)).toThrow(/"env" is null.*Nothing was written/s);
    expect(() => applyJsonEdits('{ "env": true }', edit, FILE)).toThrow(/"env" is a boolean/);
    expect(() => applyJsonEdits('{ "env": [] }', edit, FILE)).toThrow(/"env" is an array/);
  });

  it('stays friendly when the caller did not pass a file path', () => {
    // С 0.5.0 путь в сигнатуре ОБЯЗАТЕЛЕН (забытый путь ловит tsc — так его потеряли
    // пять новых адаптеров); запасной текст остался для вызова в обход типов.
    expect(() =>
      // @ts-expect-error — намеренно без третьего аргумента
      applyJsonEdits('{ "env": 5 }', [{ path: ['env', 'A'], value: 'b' }]),
    ).toThrow(/The config file: "env" is a number.*Nothing was written/s);
  });

  it('does not get in the way of ordinary edits that create missing parents', () => {
    const out = applyJsonEdits('{ "theme": "dark" }', [{ path: ['a', 'b', 'c'], value: 1 }], FILE);
    expect(JSON.parse(out).a.b.c).toBe(1);
  });
});

