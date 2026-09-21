/** Тесты core/gateway-entries — наших записей в общем массиве моделей инструмента. */
import { describe, it, expect } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';
import { applyJsonEdits } from './json-config.js';
import { gatewayUrlKey, isGatewayEntry, planSharedArrayEdits } from './gateway-entries.js';

const FILE = '/home/u/.factory/settings.json';
const OURS = 'https://gate.joingonka.ai/v1';
const ours = (id: string) => ({ id, baseUrl: OURS });

describe('isGatewayEntry', () => {
  it('recognises our gateway regardless of case and trailing slashes', () => {
    for (const baseUrl of [OURS, `${OURS}/`, `${OURS}///`, ' HTTPS://Gate.JoinGonka.ai/v1 ']) {
      expect(isGatewayEntry({ baseUrl }), baseUrl).toBe(true);
    }
  });

  it('does not claim foreign or malformed entries', () => {
    for (const entry of [
      { baseUrl: 'https://api.openai.com/v1' },
      { baseUrl: 'https://gate.joingonka.ai' }, // без /v1 — это не наш OpenAI-адрес
      { baseUrl: 5 },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731' }, // тот же id продают и другие шлюзы
      'https://gate.joingonka.ai/v1',
      null,
    ]) {
      expect(isGatewayEntry(entry)).toBe(false);
    }
  });

  it('normalises an address for comparison', () => {
    expect(gatewayUrlKey('HTTPS://X.dev/v1//')).toBe('https://x.dev/v1');
    expect(gatewayUrlKey('   ')).toBeUndefined();
    expect(gatewayUrlKey(undefined)).toBeUndefined();
  });
});

describe('planSharedArrayEdits', () => {
  const base = ['customModels'];
  const apply = (text: string, list: unknown, entries: Array<Record<string, unknown>>) =>
    applyJsonEdits(text, planSharedArrayEdits(base, list, entries), FILE);

  it('creates the array when there is none', () => {
    const out = apply('{}', undefined, [ours('a'), ours('b')]);
    expect(parseJsonc(out).customModels).toEqual([ours('a'), ours('b')]);
  });

  it('replaces our entries in place, appends the missing ones and keeps foreign entries and comments', () => {
    const text = `{
  "customModels": [
    // моя локальная модель
    { "id": "local", "baseUrl": "http://localhost:8000/v1" },
    { "id": "old-ours", "baseUrl": "https://gate.joingonka.ai/v1/" }
  ]
}`;
    const out = apply(text, parseJsonc(text).customModels, [ours('a'), ours('b')]);

    expect(out).toContain('// моя локальная модель');
    expect(parseJsonc(out).customModels).toEqual([
      { id: 'local', baseUrl: 'http://localhost:8000/v1' },
      ours('a'),
      ours('b'),
    ]);
  });

  it('rebuilds the array when we had MORE entries than the catalog has models — foreign values survive', () => {
    const list = [ours('x'), { id: 'local', baseUrl: 'http://localhost/v1' }, ours('y'), ours('z')];
    const out = apply(JSON.stringify({ customModels: list }), list, [ours('a')]);
    expect(parseJsonc(out).customModels).toEqual([ours('a'), { id: 'local', baseUrl: 'http://localhost/v1' }]);
  });

  it('is idempotent', () => {
    const first = apply('{}', undefined, [ours('a'), ours('b')]);
    const second = apply(first, parseJsonc(first).customModels, [ours('a'), ours('b')]);
    expect(second).toBe(first);
  });

  it('addresses a nested array by its path', () => {
    const edits = planSharedArrayEdits(['modelProviders', 'openai'], [ours('old')], [ours('a'), ours('b')]);
    expect(edits.map((e) => e.path)).toEqual([
      ['modelProviders', 'openai', 0],
      ['modelProviders', 'openai', -1],
    ]);
  });
});
