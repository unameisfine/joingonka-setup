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
  isRecordedPrice,
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

describe('запись модели: живая цена не затирается константой (0.5.0)', () => {
  // ★ Цена берётся из /api/pricing в момент установки. Пока правило было «нет живой
  // цены → константа», повторный запуск при недоступном шлюзе (таймаут 3 с) менял в
  // конфиге уже записанную живую цену на более грубую константу — и установка
  // переставала быть идемпотентной (это поймал smoke: два запуска, разный файл).
  const recorded = { input: 0.004321, output: 0.012963, cacheRead: 0.004321, cacheWrite: 0.004321 };
  const fallback = { input: 0.0062, output: 0.0185, cacheRead: 0.0062, cacheWrite: 0.0062 };

  it('keeps the price already recorded for the model when there is no live one', () => {
    expect(openclawModelEntry(minimax, undefined, recorded).cost).toEqual(recorded);
    expect(piModelEntry(minimax, undefined, recorded).cost).toEqual(recorded);
  });

  it('keeps the recorded block as it is — the fields the user tuned included', () => {
    const tuned = { input: 0.004321, output: 0.012963, cacheRead: 0.001, cacheWrite: 0.002 };
    expect(openclawModelEntry(minimax, undefined, tuned).cost).toBe(tuned);
    expect(piModelEntry(minimax, undefined, tuned).cost).toBe(tuned);
  });

  it('lets a live price win over the recorded one', () => {
    const live = { input: 0.005808, output: 0.017424 };
    expect(openclawModelEntry(minimax, live, recorded).cost).toEqual({
      input: 0.005808,
      output: 0.017424,
      cacheRead: 0.005808,
      cacheWrite: 0.005808,
    });
  });

  it('falls back to the constant for a NEW entry and for a recorded block that is not a price', () => {
    for (const junk of [undefined, null, 'free', 5, [], {}, { input: 0.004 }, { input: '0.004', output: 0.01 },
      { input: 0, output: 0.01 }, { input: -1, output: 0.01 }, { input: Number.NaN, output: 0.01 }]) {
      expect(openclawModelEntry(minimax, undefined, junk).cost, JSON.stringify(junk)).toEqual(fallback);
      expect(piModelEntry(minimax, undefined, junk).cost, JSON.stringify(junk)).toEqual(fallback);
    }
  });

  it('does NOT preserve the retired constant of 0.1.0–0.4.4: it never was a live price', () => {
    // До 0.4.5 в пакете стояло 0.07 / 0.1 — в 5–11 раз выше реальной цены. Сохранить
    // её «как записанную» значило бы отменить исправление 0.4.5 для всех, кто
    // обновляется при недоступном шлюзе.
    const retired = { input: 0.07, output: 0.1, cacheRead: 0.07, cacheWrite: 0.07 };
    expect(openclawModelEntry(minimax, undefined, retired).cost).toEqual(fallback);
    expect(piModelEntry(minimax, undefined, retired).cost).toEqual(fallback);
    expect(isRecordedPrice(0.07, 0.1)).toBe(false);
    expect(isRecordedPrice(0.004321, 0.012963)).toBe(true);
    expect(isRecordedPrice(0.0062, 0.0185)).toBe(true);
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
