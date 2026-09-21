/** Тесты core/catalog — каталога моделей одной установки. */
import { describe, it, expect } from 'vitest';
import { catalogFor, NETWORK_MODEL_IDS } from './catalog.js';
import { DEEPSEEK_MODEL, OPENCLAW_MODELS } from '../constants.js';

describe('catalogFor', () => {
  it('is the network catalog for a default run and for a known explicit model', () => {
    expect(catalogFor({ model: DEEPSEEK_MODEL })).toEqual([...OPENCLAW_MODELS]);
    expect(catalogFor({ model: DEEPSEEK_MODEL, modelExplicit: true })).toEqual([...OPENCLAW_MODELS]);
  });

  it('adds an explicit model from outside the catalog, with conservative limits', () => {
    const specs = catalogFor({ model: 'newvendor/Model-X', modelExplicit: true });
    expect(specs.slice(0, -1)).toEqual([...OPENCLAW_MODELS]);
    expect(specs.at(-1)).toEqual({ id: 'newvendor/Model-X', name: 'newvendor/Model-X', maxTokens: 8192 });
    // Окно не задано — адаптер подставит окно по умолчанию, а не самое большое.
    expect(specs.at(-1)!.contextWindow).toBeUndefined();
    expect(specs.at(-1)!.maxTokens).toBe(Math.min(...OPENCLAW_MODELS.map((m) => m.maxTokens)));
  });

  it('does NOT add an unknown model that was not asked for explicitly', () => {
    // Без `--model` каталог — только модели сети: так повторный запуск отличает
    // действующую модель от ушедшей.
    expect(catalogFor({ model: 'newvendor/Model-X' })).toEqual([...OPENCLAW_MODELS]);
    expect(catalogFor({ model: 'newvendor/Model-X', modelExplicit: false })).toEqual([...OPENCLAW_MODELS]);
  });

  it('never mutates the shared catalog', () => {
    const before = OPENCLAW_MODELS.length;
    catalogFor({ model: 'a/b', modelExplicit: true }).push({ id: 'x', name: 'x', maxTokens: 1 });
    expect(OPENCLAW_MODELS).toHaveLength(before);
  });

  it('exposes the ids of the network models', () => {
    expect(NETWORK_MODEL_IDS).toEqual(OPENCLAW_MODELS.map((m) => m.id));
  });
});

describe('catalogIds', () => {
  it('lists the ids of the catalog of THIS run, the explicit newcomer included', async () => {
    const { catalogIds } = await import('./catalog.js');
    expect(catalogIds({ model: DEEPSEEK_MODEL })).toEqual([...NETWORK_MODEL_IDS]);
    expect(catalogIds({ model: 'a/b', modelExplicit: true })).toEqual([...NETWORK_MODEL_IDS, 'a/b']);
    expect(catalogIds({ model: 'a/b' })).toEqual([...NETWORK_MODEL_IDS]);
  });
});
