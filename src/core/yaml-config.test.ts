/**
 * Тесты core/yaml-config — общих правил YAML-адаптеров (Hermes, omp, MiniMax
 * Code, Goose): терпимое чтение с отказом на битом файле, подготовка пути к
 * вложенному map, запись без переформатирования чужих строк.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ensureMapAt, loadYamlMap, renderYaml, YAML_REFUSAL_HINT } from './yaml-config.js';

const FILE = '/home/u/.hermes/config.yaml';

describe('loadYamlMap', () => {
  it('gives an empty document when there is no file, or the file is empty', () => {
    for (const raw of [null, '', '  \n\n']) {
      const doc = loadYamlMap(raw, FILE);
      doc.setIn(['model', 'default'], 'x');
      expect(parseYaml(renderYaml(doc, FILE))).toEqual({ model: { default: 'x' } });
    }
  });

  it('treats a comment-only file as a fresh config and keeps the comments', () => {
    const doc = loadYamlMap('# мои заметки\n', FILE);
    ensureMapAt(doc, ['model'], FILE);
    doc.setIn(['model', 'default'], 'x');
    const text = renderYaml(doc, FILE);
    expect(text).toContain('# мои заметки');
    expect(parseYaml(text)).toEqual({ model: { default: 'x' } });
  });

  it('refuses malformed YAML: names the file, the error code and the line', () => {
    const broken = 'agent:\n  max_iterations: 10\nmodel: [unclosed\n  broken: yes\n';
    expect(() => loadYamlMap(broken, FILE)).toThrow(
      /config\.yaml is not valid YAML \([A-Z_]+ at line \d+\)\. Nothing was written/,
    );
  });

  it('never quotes the file in the error — these configs hold API keys', () => {
    // Сообщение парсера содержит выдержку из файла; в ней может оказаться ключ
    // (свой или чужого провайдера). В отказ идут только код и номер строки.
    const broken = 'providers:\n  other:\n    apiKey: sk-SECRET-123\n  bad: [unclosed\nnext: 1\n';
    let message = '';
    try {
      loadYamlMap(broken, FILE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('is not valid YAML');
    expect(message).not.toContain('sk-SECRET-123');
    expect(message).not.toContain('unclosed');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('refuses a root that is not a mapping', () => {
    for (const raw of ['- just\n- a list\n', 'plain scalar\n', '42\n']) {
      expect(() => loadYamlMap(raw, FILE)).toThrow(
        /config\.yaml does not contain a YAML mapping at the top level\. Nothing was written/,
      );
    }
  });

  it('ends every refusal with the same hint as the JSON and TOML helpers', () => {
    expect(YAML_REFUSAL_HINT).toBe(
      'Nothing was written — fix the file (or move it aside) and run the installer again.',
    );
  });
});

describe('ensureMapAt', () => {
  it('leaves a missing node and an existing mapping alone', () => {
    const doc = loadYamlMap('providers:\n  other:\n    baseUrl: https://x\n', FILE);
    ensureMapAt(doc, ['providers'], FILE);
    ensureMapAt(doc, ['providers', 'joingonka'], FILE, true);
    ensureMapAt(doc, ['modelRoles'], FILE);
    expect(parseYaml(renderYaml(doc, FILE))).toEqual({ providers: { other: { baseUrl: 'https://x' } } });
  });

  it('clears an empty scalar (`key:`) so that setIn can build the mapping', () => {
    const doc = loadYamlMap('providers:\nother: 1\n', FILE);
    ensureMapAt(doc, ['providers'], FILE);
    doc.setIn(['providers', 'joingonka', 'api'], 'openai-completions');
    expect(parseYaml(renderYaml(doc, FILE))).toEqual({
      other: 1,
      providers: { joingonka: { api: 'openai-completions' } },
    });
  });

  it("refuses to overwrite the user's value where a mapping is needed", () => {
    for (const raw of ['providers: some-string\n', 'providers:\n  - a\n  - b\n', 'providers: 5\n']) {
      const doc = loadYamlMap(raw, FILE);
      expect(() => ensureMapAt(doc, ['providers'], FILE)).toThrow(
        /config\.yaml: "providers" must be a mapping\. Nothing was written/,
      );
    }
  });

  it('names a nested key by its dotted path', () => {
    const doc = loadYamlMap('custom_provider:\n  joingonka:\n    options: nope\n', FILE);
    expect(() => ensureMapAt(doc, ['custom_provider', 'joingonka', 'options'], FILE)).toThrow(
      /"custom_provider\.joingonka\.options" must be a mapping/,
    );
  });

  it("replaces junk under the installer's OWN key instead of refusing", () => {
    const doc = loadYamlMap('providers:\n  joingonka: broken\n  other:\n    api: x\n', FILE);
    ensureMapAt(doc, ['providers', 'joingonka'], FILE, true);
    doc.setIn(['providers', 'joingonka', 'api'], 'openai-completions');
    expect(parseYaml(renderYaml(doc, FILE))).toEqual({
      providers: { other: { api: 'x' }, joingonka: { api: 'openai-completions' } },
    });
  });
});

describe('renderYaml', () => {
  it("keeps comments and does not re-wrap the user's long lines", () => {
    // По умолчанию `yaml` сворачивает строки длиннее 80 колонок — то есть
    // переписывает значения, которых установщик не касался.
    const long = 'word '.repeat(40).trim();
    const url = `https://example.com/${'a'.repeat(120)}`;
    const raw =
      `# заметка\nagent:\n  system_prompt: ${long} # хвост\n  quoted: "${long}"\n  url: ${url}\n` +
      'model:\n  default: old\n';
    const doc = loadYamlMap(raw, FILE);
    doc.setIn(['model', 'default'], 'new');

    expect(renderYaml(doc, FILE)).toBe(raw.replace('default: old', 'default: new'));
  });

  it('hands back text that parses to exactly the edited value', () => {
    const doc = loadYamlMap('a: 1\n', FILE);
    doc.setIn(['b', 'c'], ['x', 'y']);
    expect(parseYaml(renderYaml(doc, FILE))).toEqual({ a: 1, b: { c: ['x', 'y'] } });
  });
});
