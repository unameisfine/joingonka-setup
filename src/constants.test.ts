/**
 * Тесты SSOT-функций пакета: форма записи модели с ценой и лимиты модели для
 * печатных инструкций.
 */
import { describe, it, expect } from 'vitest';
import {
  DEEPSEEK_MODEL,
  DEFAULT_MODEL,
  GLM_MODEL,
  OPENCLAW_MODELS,
  formatModelLimits,
  modelLimits,
  openclawModelEntry,
  piModelEntry,
} from './constants.js';

const minimax = OPENCLAW_MODELS.find((m) => m.id === DEFAULT_MODEL)!;

describe('запись модели: цена', () => {
  it('без живой цены падает на константы-фолбэк', () => {
    const cost = { input: 0.0062, output: 0.0185, cacheRead: 0.0062, cacheWrite: 0.0062 };
    expect(openclawModelEntry(minimax).cost).toEqual(cost);
    expect(piModelEntry(minimax).cost).toEqual(cost);
  });

  it('с живой ценой пишет её; кеш приравнен ко входу', () => {
    const live = { input: 0.005808, output: 0.017424 };
    const cost = { input: 0.005808, output: 0.017424, cacheRead: 0.005808, cacheWrite: 0.005808 };
    expect(openclawModelEntry(minimax, live).cost).toEqual(cost);
    expect(piModelEntry(minimax, live).cost).toEqual(cost);
  });
});

describe('modelLimits — лимиты для печатных инструкций', () => {
  it('отдаёт реальные окно и потолок ответа каждой модели каталога', () => {
    expect(modelLimits(DEFAULT_MODEL)).toEqual({ contextWindow: 200000, maxOutput: 8192, known: true });
    expect(modelLimits(DEEPSEEK_MODEL)).toEqual({ contextWindow: 380000, maxOutput: 32768, known: true });
    expect(modelLimits(GLM_MODEL)).toEqual({ contextWindow: 390000, maxOutput: 8192, known: true });
  });

  it('для модели вне каталога — осторожные значения и known:false', () => {
    // Общий контекст сети и наименьший потолок по каталогу: занизить безопаснее,
    // чем пообещать инструменту окно, которого у модели нет.
    expect(modelLimits('newvendor/Model-X')).toEqual({
      contextWindow: 200000,
      maxOutput: 8192,
      known: false,
    });
  });

  it('formatModelLimits печатает одну строку с обоими числами', () => {
    expect(formatModelLimits(DEEPSEEK_MODEL)).toBe(
      'Model limits: context window 380000 tokens, max output 32768 tokens.',
    );
    expect(formatModelLimits('newvendor/Model-X')).toContain('not in the installer catalog');
  });
});
