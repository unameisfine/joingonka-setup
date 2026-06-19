/**
 * Тесты validate.ts — валидация JoinGonka API-ключа.
 *
 * Контракт: validateApiKey(v) возвращает true для валидного ключа
 * (непустой, начинается с 'jg-') или строку-сообщение об ошибке иначе.
 * Сигнатура совместима с validate из @inquirer/prompts.
 */
import { describe, it, expect } from 'vitest';
import { validateApiKey } from './validate.js';

describe('validateApiKey', () => {
  it('accepts a key starting with jg-', () => {
    expect(validateApiKey('jg-test123')).toBe(true);
  });

  it('accepts a key with only the jg- prefix and more chars', () => {
    expect(validateApiKey('jg-abcDEF0123456789')).toBe(true);
  });

  it('rejects an empty string with a message', () => {
    const result = validateApiKey('');
    expect(typeof result).toBe('string');
  });

  it('rejects a key without the jg- prefix', () => {
    const result = validateApiKey('sk-openai-style-key');
    expect(typeof result).toBe('string');
  });

  it('rejects a key that merely contains jg- but does not start with it', () => {
    const result = validateApiKey('xjg-123');
    expect(typeof result).toBe('string');
  });

  it('rejects whitespace-only input', () => {
    const result = validateApiKey('   ');
    expect(typeof result).toBe('string');
  });
});
