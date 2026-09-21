/**
 * Тесты models.ts — разбора значения `--model`.
 *
 * Зачем: до 0.4.5 значение флага уходило в конфиг КАК ЕСТЬ. Пользователь по
 * старой инструкции писал `--model kimi` (модель выведена из сети 11.09.2026),
 * установщик записывал её в конфиг Hermes/Pi, live-проверка падала с 400, и
 * человек оставался с битым конфигом. Теперь:
 * - алиасы minimax|deepseek|glm (регистр не важен);
 * - id каталога приводится к каноничному регистру;
 * - выведенная модель — понятная ошибка ДО любой записи;
 * - незнакомое короткое слово — ошибка (это опечатка), а полный id
 *   `вендор/модель` пропускаем с предупреждением: сеть меняется чаще релизов.
 */
import { describe, it, expect } from 'vitest';
import { canonicalModel } from './models.js';
import { DEFAULT_MODEL, DEEPSEEK_MODEL, GLM_MODEL } from '../constants.js';

describe('canonicalModel', () => {
  it('falls back to the adapter default, then to the global default', () => {
    expect(canonicalModel(undefined, DEEPSEEK_MODEL).model).toBe(DEEPSEEK_MODEL);
    expect(canonicalModel(undefined).model).toBe(DEFAULT_MODEL);
    expect(canonicalModel('  ').model).toBe(DEFAULT_MODEL);
  });

  it('resolves shortcuts regardless of case', () => {
    expect(canonicalModel('deepseek').model).toBe(DEEPSEEK_MODEL);
    expect(canonicalModel('GLM').model).toBe(GLM_MODEL);
    expect(canonicalModel('MiniMax').model).toBe(DEFAULT_MODEL);
  });

  it('normalises a catalog id to its canonical casing', () => {
    expect(canonicalModel('zai-org/glm-5.3-flash').model).toBe(GLM_MODEL);
  });

  it('rejects models that left the network, naming the alternatives', () => {
    expect(() => canonicalModel('kimi')).toThrow(/no longer served/i);
    expect(() => canonicalModel('moonshotai/Kimi-K2.6')).toThrow(/--model/);
    expect(() => canonicalModel('zai-org/GLM-5.2-FP8')).toThrow(/no longer served/i);
  });

  it('rejects an unknown shortcut as a typo', () => {
    expect(() => canonicalModel('deepsek')).toThrow(/Unknown model/i);
  });

  it('allows an unknown full id but warns about it', () => {
    const resolved = canonicalModel('newvendor/Some-New-Model');
    expect(resolved.model).toBe('newvendor/Some-New-Model');
    expect(resolved.warning).toMatch(/not in this installer/i);
  });

  it('never reports a warning for catalog models', () => {
    expect(canonicalModel('deepseek').warning).toBeUndefined();
  });
});
