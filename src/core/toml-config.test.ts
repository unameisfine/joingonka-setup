/**
 * Тесты core/toml-config — чтение TOML-конфигов и ТОЧЕЧНЫЕ текстовые правки.
 *
 * Главное, что здесь закреплено: комментарии, чужие ключи и форматирование
 * пользователя переживают правку; любой отказ происходит исключением с путём
 * файла и фразой «Nothing was written»; повторная правка не меняет ни байта.
 */
import { describe, it, expect } from 'vitest';
import { parse } from 'smol-toml';
import {
  readTomlConfig,
  applyTomlEdits,
  assertOnlyIntendedChanges,
  formatTomlPath,
  type TomlEdit,
  type TomlEditValue,
} from './toml-config.js';

const FILE = '/home/me/.tool/config.toml';

const set = (table: string[], key: string, value: TomlEditValue): TomlEdit => ({
  op: 'set',
  table,
  key,
  value,
});
const remove = (table: string[], key: string): TomlEdit => ({ op: 'remove', table, key });
const removeTable = (table: string[]): TomlEdit => ({ op: 'removeTable', table });

describe('readTomlConfig', () => {
  it('treats a missing or blank file as an empty document', () => {
    expect(readTomlConfig(null, FILE)).toEqual({ text: '', value: {} });
    expect(readTomlConfig('  \n\n', FILE).value).toEqual({});
  });

  it('returns the original text untouched together with the parsed value', () => {
    const raw = '# mine\nmodel = "x"\n\n[a.b]\nc = 1\n';
    const doc = readTomlConfig(raw, FILE);
    expect(doc.text).toBe(raw);
    expect(doc.value).toEqual({ model: 'x', a: { b: { c: 1 } } });
  });

  it('refuses broken TOML with the file path, the line and "Nothing was written"', () => {
    const raw = 'model = "x"\n[broken\nkey = 1\n';
    expect(() => readTomlConfig(raw, FILE)).toThrow(FILE);
    expect(() => readTomlConfig(raw, FILE)).toThrow(/not valid TOML/);
    expect(() => readTomlConfig(raw, FILE)).toThrow(/line 2/);
    expect(() => readTomlConfig(raw, FILE)).toThrow(/Nothing was written/);
  });

  it('never echoes file contents in the error (the file holds API keys)', () => {
    const raw = 'api_key = "sk-very-secret" oops\n';
    let message = '';
    try {
      readTomlConfig(raw, FILE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Nothing was written');
    expect(message).not.toContain('sk-very-secret');
  });

  it('accepts integers beyond the safe range instead of refusing the whole file', () => {
    expect(() => readTomlConfig('big = 9007199254740993\n', FILE)).not.toThrow();
  });
});

describe('applyTomlEdits — ключи верхнего уровня', () => {
  it('writes into an empty document', () => {
    const out = applyTomlEdits('', [set([], 'model', 'm/x'), set([], 'window', 380000)], FILE);
    expect(out).toBe('model = "m/x"\nwindow = 380000\n');
  });

  it('replaces only the value: the trailing comment and neighbours stay byte-identical', () => {
    const raw = [
      '# my codex config',
      "approval_policy = 'on-request'   # keep asking",
      'model = "gpt-5.6-terra"  # daily driver',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      '',
    ].join('\n');
    const out = applyTomlEdits(raw, [set([], 'model', 'deepseek-ai/DeepSeek-V4-Flash-0731')], FILE);
    expect(out).toBe(raw.replace('"gpt-5.6-terra"', '"deepseek-ai/DeepSeek-V4-Flash-0731"'));
  });

  it('inserts a new key after the last top-level statement, before the first table', () => {
    const raw = 'model = "x"\n# model_provider = "old"\n\n[features]\nfoo = true\n';
    const out = applyTomlEdits(raw, [set([], 'model_provider', 'joingonka')], FILE);
    expect(out).toBe(
      'model = "x"\nmodel_provider = "joingonka"\n# model_provider = "old"\n\n[features]\nfoo = true\n',
    );
  });

  it('puts top-level keys above the first table when the file starts with one', () => {
    const raw = '# MCP servers\n[mcp_servers.docs]\ncommand = "npx"\n';
    const out = applyTomlEdits(raw, [set([], 'model', 'x'), set([], 'model_provider', 'jg')], FILE);
    expect(out).toBe(
      'model = "x"\nmodel_provider = "jg"\n\n# MCP servers\n[mcp_servers.docs]\ncommand = "npx"\n',
    );
  });

  it('keeps a file-level comment block on top', () => {
    const raw = '# Codex config\n# edited by hand\n\n[features]\nfoo = true\n';
    const out = applyTomlEdits(raw, [set([], 'model', 'x')], FILE);
    expect(out).toBe('# Codex config\n# edited by hand\n\nmodel = "x"\n\n[features]\nfoo = true\n');
  });

  it('does not confuse a same-named key inside a table with the top-level one', () => {
    const raw = '[profiles.fast]\nmodel = "gpt-5.6-luna"\n';
    const out = applyTomlEdits(raw, [set([], 'model', 'x')], FILE);
    expect(parse(out)).toEqual({ model: 'x', profiles: { fast: { model: 'gpt-5.6-luna' } } });
    expect(out).toContain('[profiles.fast]\nmodel = "gpt-5.6-luna"\n');
  });

  it('replaces literal strings and values that contain "#"', () => {
    const raw = "model = 'a#b' # note\n";
    expect(applyTomlEdits(raw, [set([], 'model', 'c')], FILE)).toBe('model = "c" # note\n');
  });

  it('is not fooled by table-like lines inside multi-line strings, arrays and comments', () => {
    const raw = [
      'notes = """',
      '[model_providers.joingonka]',
      'name = "fake"',
      '"""',
      'matrix = [',
      '  [1, 2], # [model_providers.joingonka]',
      '  [3, 4],',
      ']',
      "raw = '''",
      '[[hooks]]',
      "'''",
      '# [model_providers.joingonka]',
      'inline = {',
      '  a = 1,',
      '}',
      '',
    ].join('\n');
    const out = applyTomlEdits(
      raw,
      [set(['model_providers', 'joingonka'], 'name', 'JoinGonka'), set([], 'model', 'x')],
      FILE,
    );
    expect(out).toBe(
      raw.replace('}\n', '}\nmodel = "x"\n') + '\n[model_providers.joingonka]\nname = "JoinGonka"\n',
    );
  });

  it('refuses to put a value where the user keeps a table', () => {
    const raw = '[model]\nname = "x"\n';
    expect(() => applyTomlEdits(raw, [set([], 'model', 'x')], FILE)).toThrow(
      /"model".*table.*Nothing was written/s,
    );
  });
});

describe('applyTomlEdits — таблицы', () => {
  const PROVIDER: TomlEdit[] = [
    set(['model_providers', 'joingonka'], 'name', 'JoinGonka'),
    set(['model_providers', 'joingonka'], 'base_url', 'https://gate.joingonka.ai/v1'),
  ];

  it('appends a new table at the end, separated by one blank line', () => {
    const raw = 'model = "x"\n\n[features]\nfoo = true';
    const out = applyTomlEdits(raw, PROVIDER, FILE);
    expect(out).toBe(
      'model = "x"\n\n[features]\nfoo = true\n\n[model_providers.joingonka]\n' +
        'name = "JoinGonka"\nbase_url = "https://gate.joingonka.ai/v1"\n',
    );
  });

  it('updates our keys in place and keeps the user keys and comments of the same table', () => {
    const raw = [
      '[model_providers.joingonka]',
      '# tuned by hand',
      'name = "old name"',
      'stream_idle_timeout_ms = 600000 # slow network',
      '',
      '[model_providers.other]',
      'name = "Other"',
      '',
    ].join('\n');
    const out = applyTomlEdits(raw, PROVIDER, FILE);
    expect(out).toBe(
      [
        '[model_providers.joingonka]',
        '# tuned by hand',
        'name = "JoinGonka"',
        'stream_idle_timeout_ms = 600000 # slow network',
        'base_url = "https://gate.joingonka.ai/v1"',
        '',
        '[model_providers.other]',
        'name = "Other"',
        '',
      ].join('\n'),
    );
  });

  it('matches quoted, literal and spaced table headers', () => {
    const alias = 'joingonka/zai-org/GLM-5.3-Flash';
    for (const header of [
      `[models."${alias}"]`,
      `[models.'${alias}']`,
      `[ models . "${alias}" ]   # mine`,
    ]) {
      const raw = `${header}\nprovider = "x"\n`;
      const out = applyTomlEdits(raw, [set(['models', alias], 'provider', 'joingonka')], FILE);
      expect(out).toBe(`${header}\nprovider = "joingonka"\n`);
    }
  });

  it('quotes table and key names that are not bare keys', () => {
    const out = applyTomlEdits(
      '',
      [set(['models', 'joingonka/a.b'], 'model', 'a.b'), set(['pool'], 'joingonka/a.b', '')],
      FILE,
    );
    expect(out).toBe('[models."joingonka/a.b"]\nmodel = "a.b"\n\n[pool]\n"joingonka/a.b" = ""\n');
    expect(formatTomlPath(['models', 'joingonka/a.b'])).toBe('models."joingonka/a.b"');
  });

  it('writes arrays, booleans and escaped strings that read back exactly', () => {
    const tricky = 'q"uo\\te\nnew\tline \u0001 ü';
    const out = applyTomlEdits(
      '',
      [
        set(['t'], 'capabilities', ['thinking', 'tool_use']),
        set(['t'], 'enabled', true),
        set(['t'], 'text', tricky),
      ],
      FILE,
    );
    expect(out).toContain('capabilities = ["thinking", "tool_use"]\n');
    expect(parse(out)).toEqual({
      t: { capabilities: ['thinking', 'tool_use'], enabled: true, text: tricky },
    });
  });

  it('adds an explicit header for a table that so far existed only through its sub-table', () => {
    const raw = '[model_providers.joingonka.http_headers]\nX-Team = "core"\n';
    const out = applyTomlEdits(raw, PROVIDER, FILE);
    expect(parse(out)).toEqual({
      model_providers: {
        joingonka: {
          name: 'JoinGonka',
          base_url: 'https://gate.joingonka.ai/v1',
          http_headers: { 'X-Team': 'core' },
        },
      },
    });
    expect(out.startsWith(raw)).toBe(true);
  });

  it.each([
    ['dotted keys', 'model_providers.joingonka.name = "x"\n'],
    ['an inline table', 'model_providers = { joingonka = { name = "x" } }\n'],
    ['dotted keys inside the parent table', '[model_providers]\njoingonka.name = "x"\n'],
  ])('refuses our table written as %s — that form cannot be edited safely', (_form, raw) => {
    expect(() => applyTomlEdits(raw, PROVIDER, FILE)).toThrow(
      /model_providers\.joingonka.*Nothing was written/s,
    );
    expect(() => applyTomlEdits(raw, PROVIDER, FILE)).toThrow(FILE);
  });

  it('refuses an array of tables and a scalar in place of our table', () => {
    expect(() =>
      applyTomlEdits('[[model_providers.joingonka]]\nname = "x"\n', PROVIDER, FILE),
    ).toThrow(/expected to be a table.*Nothing was written/s);
    expect(() => applyTomlEdits('model_providers = "oops"\n', PROVIDER, FILE)).toThrow(
      /"model_providers".*expected to be a table.*Nothing was written/s,
    );
  });

  it('refuses when the parent is an inline table that a [header] cannot extend', () => {
    const raw = 'model_providers = { other = { name = "Other" } }\n';
    expect(() => applyTomlEdits(raw, PROVIDER, FILE)).toThrow(/Nothing was written/);
  });
});

describe('applyTomlEdits — удаление', () => {
  it('removes a key together with its multi-line value, nothing else', () => {
    const raw = '[p]\nname = "x"\nenv_key = """\nJOINGONKA\n"""  # old way\nbase_url = "u"\n';
    expect(applyTomlEdits(raw, [remove(['p'], 'env_key')], FILE)).toBe(
      '[p]\nname = "x"\nbase_url = "u"\n',
    );
  });

  it('is a no-op for an absent key or table', () => {
    const raw = '[p]\nname = "x"\n';
    expect(applyTomlEdits(raw, [remove(['p'], 'env_key'), remove(['q'], 'k')], FILE)).toBe(raw);
    expect(applyTomlEdits(raw, [removeTable(['models', 'gone'])], FILE)).toBe(raw);
  });

  it('refuses to remove a key that is written as a sub-table', () => {
    const raw = '[p]\nname = "x"\n\n[p.auth]\ncommand = "tok"\n';
    expect(() => applyTomlEdits(raw, [remove(['p'], 'auth')], FILE)).toThrow(/Nothing was written/);
  });

  it('removes a table with its sub-tables; comments above it and other tables stay', () => {
    const raw = [
      '[models."joingonka/live"]',
      'provider = "joingonka"',
      '',
      '# retired in September',
      '[models."joingonka/old"]',
      'provider = "joingonka"',
      '# inner note',
      'model = "old"',
      '',
      '[models."joingonka/old".overrides]',
      'display_name = "Old"',
      '',
      '[thinking]',
      'enabled = true',
      '',
    ].join('\n');
    const out = applyTomlEdits(raw, [removeTable(['models', 'joingonka/old'])], FILE);
    expect(out).toBe(
      [
        '[models."joingonka/live"]',
        'provider = "joingonka"',
        '',
        '# retired in September',
        '',
        '[thinking]',
        'enabled = true',
        '',
      ].join('\n'),
    );
  });

  it('copes with the implicit parent disappearing together with its last table', () => {
    const raw = 'a = 1\n\n[models.only]\nprovider = "joingonka"\n';
    const out = applyTomlEdits(raw, [removeTable(['models', 'only'])], FILE);
    expect(parse(out)).toEqual({ a: 1 });
  });

  it('keeps an explicitly declared empty parent', () => {
    const raw = '[models]\n\n[models.only]\nprovider = "joingonka"\n';
    const out = applyTomlEdits(raw, [removeTable(['models', 'only'])], FILE);
    expect(parse(out)).toEqual({ models: {} });
  });

  it('removes a table that exists only through its sub-tables', () => {
    const raw = 'a = 1\n\n[pool.models]\nx = "hint"\n\n[pool.limits]\nn = 2\n';
    expect(applyTomlEdits(raw, [removeTable(['pool'])], FILE)).toBe('a = 1\n');
  });

  it('refuses when part of the table lives in dotted keys of its parent', () => {
    const raw = '[models]\nold.provider = "joingonka"\n\n[models.old.overrides]\nname = "x"\n';
    expect(() => applyTomlEdits(raw, [removeTable(['models', 'old'])], FILE)).toThrow(
      /models\.old.*Nothing was written/s,
    );
  });

  it('refuses to remove a table written inline', () => {
    const raw = '[models]\nold = { provider = "joingonka" }\n';
    expect(() => applyTomlEdits(raw, [removeTable(['models', 'old'])], FILE)).toThrow(
      /models\.old.*Nothing was written/s,
    );
  });
});

describe('applyTomlEdits — идемпотентность и переводы строк', () => {
  const EDITS: TomlEdit[] = [
    set([], 'model', 'm'),
    set([], 'model_provider', 'joingonka'),
    set(['model_providers', 'joingonka'], 'name', 'JoinGonka'),
    set(['model_providers', 'joingonka'], 'caps', ['a', 'b']),
    remove(['model_providers', 'joingonka'], 'env_key'),
  ];

  it('a second pass changes nothing, byte for byte', () => {
    const raw = '# top\n\n[features]\nfoo = true\n\n[model_providers.joingonka]\nenv_key = "K"\n';
    const once = applyTomlEdits(raw, EDITS, FILE);
    expect(applyTomlEdits(once, EDITS, FILE)).toBe(once);
  });

  it('leaves an equal value alone even when the user spelled it differently', () => {
    const raw = "model = 'm'\ncaps = [\n  'a', # first\n  'b',\n]\n";
    expect(applyTomlEdits(raw, [set([], 'model', 'm'), set([], 'caps', ['a', 'b'])], FILE)).toBe(raw);
  });

  it('keeps CRLF line endings', () => {
    const raw = 'model = "x"\r\n\r\n[features]\r\nfoo = true\r\n';
    const out = applyTomlEdits(raw, [set([], 'model_provider', 'jg'), set(['p'], 'k', 1)], FILE);
    expect(out).toBe(
      'model = "x"\r\nmodel_provider = "jg"\r\n\r\n[features]\r\nfoo = true\r\n\r\n[p]\r\nk = 1\r\n',
    );
  });

  it('reads a file that starts with a BOM and keeps the BOM in place', () => {
    const raw = '\uFEFFmodel = "x"\n';
    expect(readTomlConfig(raw, FILE).value).toEqual({ model: 'x' });
    expect(applyTomlEdits(raw, [set([], 'model_provider', 'jg')], FILE)).toBe(
      '\uFEFFmodel = "x"\nmodel_provider = "jg"\n',
    );
  });

  it('always ends the file with a newline', () => {
    expect(applyTomlEdits('a = 1', [], FILE)).toBe('a = 1\n');
  });
});

describe('assertOnlyIntendedChanges — страховка', () => {
  const before = parse('model = "x"\n[other]\nkey = "user"\n');

  it('passes when the result differs only the intended way', () => {
    const expected = { ...before, model: 'y' };
    expect(() =>
      assertOnlyIntendedChanges('model = "y"\n[other]\nkey = "user"\n', expected, FILE),
    ).not.toThrow();
  });

  it('refuses a result that touched a foreign value', () => {
    const expected = { ...before, model: 'y' };
    expect(() =>
      assertOnlyIntendedChanges('model = "y"\n[other]\nkey = "changed"\n', expected, FILE),
    ).toThrow(/Nothing was written/);
  });

  it('refuses a result that no longer parses', () => {
    expect(() => assertOnlyIntendedChanges('model = \n', { model: 'y' }, FILE)).toThrow(
      /Nothing was written/,
    );
  });
});
