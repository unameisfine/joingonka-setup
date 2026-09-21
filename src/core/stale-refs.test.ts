/**
 * Тесты чистки ссылок на убранные модели вне каталога провайдера
 * (общая часть opencode и Kilo). Поведение целиком — в тестах адаптеров.
 */
import { describe, it, expect } from 'vitest';
import { opencodeStaleRefEdits, staleRefsNote } from './stale-refs.js';

const CATALOG = ['MiniMaxAI/MiniMax-M2.7', 'zai-org/GLM-5.3-Flash'];
const KIMI = 'joingonka/moonshotai/Kimi-K2.6';
const REPLACEMENT = 'joingonka/MiniMaxAI/MiniMax-M2.7';

describe('opencodeStaleRefEdits', () => {
  it('находит нашу убранную модель во всех разделах с полем model', () => {
    const edits = opencodeStaleRefEdits(
      {
        small_model: KIMI,
        agent: { plan: { model: KIMI } },
        mode: { old: { model: KIMI } },
        command: { test: { template: 't', model: KIMI } },
      },
      'joingonka',
      CATALOG,
      REPLACEMENT,
    );

    expect(edits).toEqual([
      { path: ['small_model'], value: REPLACEMENT },
      { path: ['agent', 'plan', 'model'], value: REPLACEMENT },
      { path: ['mode', 'old', 'model'], value: REPLACEMENT },
      { path: ['command', 'test', 'model'], value: REPLACEMENT },
    ]);
  });

  it('не трогает чужих провайдеров, актуальные наши модели и кривые формы', () => {
    const edits = opencodeStaleRefEdits(
      {
        small_model: 'anthropic/claude-haiku-4-5',
        agent: {
          build: { model: 'joingonka/zai-org/GLM-5.3-Flash' },
          review: { model: 'openai/gpt-5.4' },
          nomodel: { prompt: 'x' },
          broken: 'not-an-object',
        },
        command: ['not', 'an', 'object'],
      },
      'joingonka',
      CATALOG,
      REPLACEMENT,
    );

    expect(edits).toEqual([]);
  });

  it('top-level model оставляет адаптеру', () => {
    expect(opencodeStaleRefEdits({ model: KIMI }, 'joingonka', CATALOG, REPLACEMENT)).toEqual([]);
  });
});

describe('staleRefsNote', () => {
  it('молчит, когда чистить было нечего', () => {
    expect(staleRefsNote(0)).toBeNull();
  });

  it('согласует число', () => {
    expect(staleRefsNote(1)).toContain('1 reference to');
    expect(staleRefsNote(3)).toContain('3 references to');
  });
});
