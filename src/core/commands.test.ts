/**
 * Настоящий запуск внешних программ (core/commands.ts). Дочерний процесс здесь —
 * сам node: так тест не зависит от того, что ещё стоит на машине.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platform } from 'node:os';
import { runCommand } from './commands.js';

// На Windows команда идёт через cmd.exe и принимает только простые аргументы
// (см. commands.ts) — скрипты `node -e` с пробелами там не запустить.
const posix = platform() !== 'win32';

describe.runIf(posix)('runCommand', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.JOINGONKA_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.JOINGONKA_API_KEY;
    else process.env.JOINGONKA_API_KEY = savedKey;
  });

  it('hands the input to the program through stdin and returns its output and exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'secret-through-stdin',
    });
    expect(result).toEqual({ code: 0, stdout: 'secret-through-stdin', stderr: '' });
  });

  it('reports a non-zero exit code and stderr as they are', async () => {
    const result = await runCommand(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.error).toBeUndefined();
  });

  it('does not pass JOINGONKA_API_KEY to the program', async () => {
    // Ключ нужен только установщику; программа (и фоновый сервис, который
    // OpenCode 2 поднимает от неё) получать его через окружение не должна.
    process.env.JOINGONKA_API_KEY = 'jg-must-not-leak';
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stdout.write(process.env.JOINGONKA_API_KEY ?? "unset")',
    ]);
    expect(result.stdout).toBe('unset');
  });

  it('says "not-found" for a program that is not installed', async () => {
    const result = await runCommand('joingonka-no-such-program-4f1c', ['--version']);
    expect(result.error).toBe('not-found');
    expect(result.code).toBeNull();
  });

  it('stops a program that does not finish in time', async () => {
    const started = Date.now();
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      timeoutMs: 300,
    });
    expect(result.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
