/**
 * Гейт расхождения документации с реестром адаптеров.
 *
 * ★ Зачем. Список инструментов живёт в реестре (src/adapters/registry.ts), а
 * повторяется в README (таблица, пример `--tool`, числа в тексте), в package.json
 * (description, keywords) и в CHANGELOG. До 0.5.0 всё это правилось руками: в
 * cli.ts стояло «15 tools supported» и перечень id литералом. CLI теперь считает
 * список из реестра (src/cli-text.ts), а документы сверяет этот тест — добавленный
 * адаптер без строки в README роняет сборку релиза (`prepublishOnly` гоняет тесты).
 *
 * Гейт покрывает ВСЕ витрины сразу: README, package.json, CHANGELOG и `--help`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, toolIds } from './adapters/registry.js';
import { programDescription, toolOptionDescription } from './cli-text.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string) => readFileSync(resolve(ROOT, name), 'utf-8');

const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  description: string;
  keywords: string[];
  files: string[];
};

const ids = toolIds();
const writers = ids.filter((id) => adapters[id].format !== 'instructions');

/** Строки таблицы «Supported tools»: id из второй колонки → вся строка. */
function toolTableRows(): Map<string, string> {
  const section = readme.split(/^## Supported tools$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    // id начинается с буквы: заголовок колонки (`--tool`) строкой инструмента не считается.
    const id = /^`([a-z][a-z0-9-]*)`$/.exec(cells[2] ?? '')?.[1];
    if (id !== undefined) rows.set(id, line);
  }
  return rows;
}

describe('CLI help', () => {
  it('takes the number of tools from the registry', () => {
    expect(programDescription()).toContain(`${ids.length} tools supported`);
  });

  it('lists every tool id in the --tool description, in menu order', () => {
    expect(toolOptionDescription()).toBe(`Tool: ${ids.join(' | ')}`);
  });
});

describe('README', () => {
  it('has a row for every registered tool in the "Supported tools" table — and no others', () => {
    expect([...toolTableRows().keys()].sort()).toEqual([...ids].sort());
  });

  it('labels each row with the method the adapter really uses', () => {
    const method: Record<string, RegExp> = {
      json: /\bJSONC?\b/,
      yaml: /\bYAML\b/,
      toml: /\bTOML\b/,
      instructions: /\binstructions\b/,
    };
    for (const [id, row] of toolTableRows()) {
      const cell = row.split('|')[3] ?? '';
      expect(cell, `${id}: "${cell.trim()}"`).toMatch(method[adapters[id as keyof typeof adapters].format]!);
    }
  });

  it('lists exactly the registered ids in the --tool option, in menu order', () => {
    const option = /^- `--tool <([^>]+)>`/m.exec(readme)?.[1];
    expect(option, 'the "--tool <…>" line in ## Options').toBeDefined();
    expect(option!.split('|')).toEqual(ids);
  });

  it('states the number of tools the registry has, everywhere it states one', () => {
    const counts = [...readme.matchAll(/\b(\d+) (?:agentic AI |AI )?(?:coding )?tools\b/g)].map((m) =>
      Number(m[1]),
    );
    // «configures N … tools», «One key, N tools» и разбивка «N tools get their config written».
    expect(counts.length).toBeGreaterThanOrEqual(3);
    for (const count of counts) {
      expect([ids.length, writers.length]).toContain(count);
    }
    expect(counts).toContain(ids.length);
  });

  it('splits the tools into written configs and printed instructions correctly', () => {
    const split = /\b(\d+) tools get their config written[^.]*?\bother (\d+)\b/.exec(readme);
    expect(split, 'the "N tools get their config written … the other M" sentence').not.toBeNull();
    expect(Number(split![1])).toBe(writers.length);
    expect(Number(split![2])).toBe(ids.length - writers.length);
  });

  it('only advertises --tool ids that exist', () => {
    for (const [, id] of readme.matchAll(/--tool ([a-z][a-z0-9-]*)/g)) {
      expect(ids, `README mentions --tool ${id}`).toContain(id);
    }
  });
});

describe('package.json', () => {
  it('states the number of tools the registry has in the description', () => {
    const count = /\b(\d+) agentic AI coding tools\b/.exec(pkg.description)?.[1];
    expect(Number(count)).toBe(ids.length);
  });

  it('has a search keyword for every tool', () => {
    for (const id of ids) {
      const covered = pkg.keywords.some(
        (keyword) => keyword === id || keyword.startsWith(`${id}-`) || keyword.endsWith(`-${id}`),
      );
      expect(covered, `no keyword for "${id}"`).toBe(true);
    }
    expect(new Set(pkg.keywords).size).toBe(pkg.keywords.length);
  });

  it('ships the changelog, the README and the license with the build', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']));
  });
});

describe('CHANGELOG', () => {
  it('opens with the version that package.json is about to publish', () => {
    const latest = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m.exec(changelog)?.[1];
    expect(latest).toBe(pkg.version);
  });

  it('names every tool added in 0.5.0', () => {
    const entry = changelog.split(/^## \[0\.5\.0\][^\n]*$/m)[1]?.split(/^## \[/m)[0] ?? '';
    for (const id of [
      'codex',
      'kimi-code',
      'omp',
      'minimax-code',
      'goose',
      'mimo-code',
      'qwen-code',
      'droid',
      'crush',
      'zoo',
    ]) {
      expect(entry, `0.5.0 entry does not mention --tool ${id}`).toContain(`\`--tool ${id}\``);
    }
  });
});
