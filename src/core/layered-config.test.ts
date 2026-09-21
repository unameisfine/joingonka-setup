/**
 * Тесты core/layered-config — выбора файла для записи у инструментов, которые
 * сливают несколько глобальных конфигов (opencode, Kilo Code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inheritedModel, pickLayeredConfig, readLowerConfigs } from './layered-config.js';
import type { PathContext } from './paths.js';

// Порядок opencode по УБЫВАНИЮ приоритета загрузки.
const NAMES = ['opencode.jsonc', 'opencode.json', 'config.json'] as const;

let dir: string;
let ctx: PathContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joingonka-layered-'));
  ctx = { platform: 'linux', env: {}, home: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pick = (override?: string) =>
  pickLayeredConfig({ dir, names: NAMES, defaultName: 'opencode.json', override, ctx });

describe('pickLayeredConfig', () => {
  it('creates the default file when no global config exists', () => {
    expect(pick()).toEqual({ target: join(dir, 'opencode.json'), lower: [] });
  });

  it('keeps writing to the only existing file', () => {
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(pick()).toEqual({ target: join(dir, 'config.json'), lower: [] });
  });

  it('picks the existing file the tool loads LAST, so that what we write takes effect', () => {
    // Случай из аудита: opencode сам создал opencode.jsonc, прежний установщик
    // записал рядом opencode.json — действует то, что лежит в .jsonc.
    writeFileSync(join(dir, 'opencode.json'), '{}');
    writeFileSync(join(dir, 'opencode.jsonc'), '{}');
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(pick()).toEqual({
      target: join(dir, 'opencode.jsonc'),
      lower: [join(dir, 'opencode.json'), join(dir, 'config.json')],
    });
  });

  it('writes to the override layer when the tool is pointed at one; every global file is below it', () => {
    writeFileSync(join(dir, 'opencode.jsonc'), '{}');
    const custom = join(dir, 'custom', 'my.json');
    expect(pick(custom)).toEqual({ target: custom, lower: [join(dir, 'opencode.jsonc')] });
  });

  it('does not list the override twice when it is one of the global files', () => {
    writeFileSync(join(dir, 'opencode.json'), '{}');
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(pick(join(dir, 'opencode.json'))).toEqual({
      target: join(dir, 'opencode.json'),
      lower: [join(dir, 'config.json')],
    });
  });

  it('builds paths for the target platform', () => {
    const win: PathContext = { platform: 'win32', env: {}, home: 'C:\\Users\\u' };
    const files = pickLayeredConfig({
      dir: 'C:\\Users\\u\\.config\\kilo',
      names: ['kilo.jsonc', 'kilo.json'],
      defaultName: 'kilo.jsonc',
      ctx: win,
    });
    expect(files).toEqual({ target: 'C:\\Users\\u\\.config\\kilo\\kilo.jsonc', lower: [] });
  });
});

describe('readLowerConfigs / inheritedModel', () => {
  it('takes `model` from the highest-priority lower file that sets it', () => {
    writeFileSync(join(dir, 'opencode.json'), '{ "theme": "dark" }');
    writeFileSync(join(dir, 'config.json'), '{ // старый файл\n "model": "anthropic/claude-x", }');
    const { docs, unreadable } = readLowerConfigs([join(dir, 'opencode.json'), join(dir, 'config.json')]);
    expect(unreadable).toEqual([]);
    expect(inheritedModel(docs)).toBe('anthropic/claude-x');

    writeFileSync(join(dir, 'opencode.json'), '{ "model": "joingonka/zai-org/GLM-5.3-Flash" }');
    const again = readLowerConfigs([join(dir, 'opencode.json'), join(dir, 'config.json')]);
    expect(inheritedModel(again.docs)).toBe('joingonka/zai-org/GLM-5.3-Flash');
  });

  it('ignores an empty or non-string model', () => {
    writeFileSync(join(dir, 'opencode.json'), '{ "model": "  " }');
    writeFileSync(join(dir, 'config.json'), '{ "model": 5 }');
    const { docs } = readLowerConfigs([join(dir, 'opencode.json'), join(dir, 'config.json')]);
    expect(inheritedModel(docs)).toBeUndefined();
  });

  it('reports an unparsable lower file instead of failing — it is not the file we write', () => {
    writeFileSync(join(dir, 'opencode.json'), '{ broken');
    writeFileSync(join(dir, 'config.json'), '{ "model": "x/y" }');
    const { docs, unreadable } = readLowerConfigs([join(dir, 'opencode.json'), join(dir, 'config.json')]);
    expect(unreadable).toEqual([join(dir, 'opencode.json')]);
    expect(docs.map((d) => d.path)).toEqual([join(dir, 'config.json')]);
    expect(inheritedModel(docs)).toBe('x/y');
  });
});
