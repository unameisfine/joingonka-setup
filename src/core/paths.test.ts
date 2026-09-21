/**
 * Тесты кирпичей для путей: всё окружение приходит параметром, поэтому
 * Windows-ветки проверяются на любой машине.
 */
import { describe, it, expect } from 'vitest';
import { envValue, expandTilde, pathApi, xdgConfigHome, xdgDataHome, type PathContext } from './paths.js';

const linux = (env: NodeJS.ProcessEnv = {}): PathContext => ({
  platform: 'linux',
  env,
  home: '/home/u',
});
const windows = (env: NodeJS.ProcessEnv = {}): PathContext => ({
  platform: 'win32',
  env,
  home: 'C:\\Users\\u',
});

describe('envValue', () => {
  it('обрезает пробелы, пустое считает отсутствием', () => {
    expect(envValue(linux({ X: '  /a  ' }), 'X')).toBe('/a');
    expect(envValue(linux({ X: '   ' }), 'X')).toBeUndefined();
    expect(envValue(linux(), 'X')).toBeUndefined();
  });
});

describe('expandTilde', () => {
  it('раскрывает ~ и ~/… в домашний каталог', () => {
    expect(expandTilde('~', linux())).toBe('/home/u');
    expect(expandTilde('~/pi-agent', linux())).toBe('/home/u/pi-agent');
  });

  it('на Windows понимает и ~\\…', () => {
    expect(expandTilde('~\\pi-agent', windows())).toBe('C:\\Users\\u\\pi-agent');
  });

  it('не трогает обычный путь и тильду в середине', () => {
    expect(expandTilde('/opt/~tmp', linux())).toBe('/opt/~tmp');
    expect(expandTilde('~user/x', linux())).toBe('~user/x');
  });
});

describe('xdgConfigHome / xdgDataHome — как у пакета xdg-basedir', () => {
  it('берут переменную, если она задана', () => {
    const ctx = linux({ XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' });
    expect(xdgConfigHome(ctx)).toBe('/x/cfg');
    expect(xdgDataHome(ctx)).toBe('/x/data');
  });

  it('иначе — каталоги в домашнем, и на Windows тоже', () => {
    expect(xdgConfigHome(linux())).toBe('/home/u/.config');
    expect(xdgDataHome(linux())).toBe('/home/u/.local/share');
    expect(xdgConfigHome(windows())).toBe('C:\\Users\\u\\.config');
    expect(xdgDataHome(windows())).toBe('C:\\Users\\u\\.local\\share');
  });
});

describe('pathApi', () => {
  it('даёт разделитель целевой платформы', () => {
    expect(pathApi(windows()).join('C:\\a', 'b')).toBe('C:\\a\\b');
    expect(pathApi(linux()).join('/a', 'b')).toBe('/a/b');
  });
});
