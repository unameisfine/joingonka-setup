/** Тесты Roo-адаптера (instructions-only). */
import { describe, it, expect } from 'vitest';
import { rooAdapter } from './roo.js';
import { getAdapter } from './registry.js';

const input = { apiKey: 'jg-test123', model: 'zai-org/GLM-5.3-Flash', scope: 'user' as const };

describe('rooAdapter', () => {
  it('does not write a file (instructions-only)', async () => {
    expect(rooAdapter.resolvePath('user')).toBeNull();
    expect((await rooAdapter.apply(input)).wrote).toBe(false);
  });

  it('instructions carry OpenAI Compatible fields (Base URL /v1, key, model)', async () => {
    const text = (await rooAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('OpenAI Compatible');
    expect(text).toContain('https://gate.joingonka.ai/v1');
    expect(text).toContain('jg-test123');
    expect(text).toContain('zai-org/GLM-5.3-Flash');
  });

  // Расширение закрыто 15.05.2026 (README github.com/RooCodeInc/Roo-Code, репозиторий
  // в архиве, последний релиз v3.54.0). Молча печатать инструкцию к закрытому
  // продукту нельзя — но и отнимать её у тех, у кого расширение ещё стоит, тоже.
  it('opens with the shutdown notice and the alternatives, THEN the instructions', async () => {
    const { messages } = await rooAdapter.apply(input);
    const text = messages.join('\n');

    expect(messages[0]).toMatch(/shut down/i);
    expect(text.indexOf('shut down')).toBeLessThan(text.indexOf('API Provider: OpenAI Compatible'));
    expect(text).toContain('May 15, 2026');
    // Куда идти: преемник-форк, Cline и Kilo. Инструмент, который этот установщик
    // умеет ставить, назван командой; пока его в реестре нет — адресом проекта.
    expect(text).toContain('Zoo Code');
    expect(text).toContain(getAdapter('zoo') ? '--tool zoo' : 'github.com/Zoo-Code-Org/Zoo-Code');
    expect(text).toContain('--tool kilo');
    expect(text).toContain('--tool cline');
  });

  // Гейт согласованности: заметка отправляет человека командой `--tool <id>`, и
  // каждый такой id обязан существовать в реестре — иначе совет заканчивается
  // ошибкой «Unknown tool». Состав реестра меняется отдельно от roo.ts, поэтому
  // адаптер сверяется с ним сам, а тест держит это свойство.
  it('only recommends tools this installer can actually set up', async () => {
    const text = (await rooAdapter.apply(input)).messages.join('\n');
    const recommended = [...text.matchAll(/--tool ([a-z-]+)/g)].map((m) => m[1]!);

    expect(recommended.length).toBeGreaterThanOrEqual(2);
    for (const id of recommended) {
      expect(getAdapter(id), `--tool ${id} is advertised but not registered`).toBeDefined();
    }
  });

  it('says so in the tool menu as well', () => {
    expect(rooAdapter.label).toMatch(/shut down/i);
  });

  it('prints the real limits of the chosen model', async () => {
    const text = (await rooAdapter.apply(input)).messages.join('\n');
    expect(text).toContain('390000');
    expect(text).toContain('8192');
  });
});
