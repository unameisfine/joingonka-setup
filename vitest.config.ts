import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Тесты лежат рядом с исходниками в src/, имена файлов *.test.ts
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
