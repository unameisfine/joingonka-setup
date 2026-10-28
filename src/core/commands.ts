/**
 * Запуск внешней программы — за внедряемой функцией RunCommand.
 *
 * Зачем внедряемая: адаптер opencode узнаёт версию OpenCode и кладёт ключ в
 * хранилище OpenCode 2 его же командами (adapters/opencode-v2.ts). Тесты подставляют
 * поддельный CLI (testing/fake-opencode.ts) и не зависят от того, стоит ли OpenCode
 * на машине разработчика. Настоящий `runCommand` передаёт оркестратору только cli.ts.
 *
 * ★ Секреты — только через stdin (`input`), никогда в аргументах: аргументы видны в
 * списке процессов. Из окружения программы убираем JOINGONKA_API_KEY: программе ключ
 * через окружение не нужен, а OpenCode 2 ещё и поднимает от неё фоновый сервис
 * (`opencode serve --service`), который живёт дольше установщика.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { API_KEY_ENV } from '../constants.js';

/** Чем закончился запуск. */
export interface CommandResult {
  /** Код выхода; null — программа не запустилась или остановлена по таймауту. */
  code: number | null;
  stdout: string;
  stderr: string;
  /**
   * Почему не получилось запустить: 'not-found' — программы нет в PATH;
   * 'timeout' — не уложилась в срок и остановлена; 'failed' — другая ошибка запуска.
   */
  error?: 'not-found' | 'timeout' | 'failed';
}

export interface CommandOptions {
  /** Что подать на stdin — единственный путь для секретов. */
  input?: string;
  /** Сколько ждать, мс (по умолчанию 30 с). */
  timeoutMs?: number;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * На Windows npm ставит команды обёртками `.cmd`, а их запускает только оболочка —
 * команда уходит в cmd.exe одной строкой. Поэтому там допускаем лишь простые слова
 * без пробелов и спецсимволов (у нас это имена подкоманд и флагов).
 */
const SAFE_WORD = /^[A-Za-z0-9_.:=/-]+$/;

/** Окружение программы: всё, кроме ключа установщика. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[API_KEY_ENV];
  return copy;
}

function start(command: string, args: readonly string[]): ChildProcess {
  const env = commandEnv();
  if (process.platform === 'win32') {
    return spawn([command, ...args].join(' '), { shell: true, env, windowsHide: true });
  }
  return spawn(command, [...args], { env, stdio: 'pipe' });
}

export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    if (process.platform === 'win32' && ![command, ...args].every((word) => SAFE_WORD.test(word))) {
      resolve({ code: null, stdout: '', stderr: 'refused: argument is not a plain word', error: 'failed' });
      return;
    }

    let child: ChildProcess;
    try {
      child = start(command, args);
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: (err as Error).message, error: 'failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: 'timeout' });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish({
        code: null,
        stdout,
        stderr: stderr || err.message,
        error: err.code === 'ENOENT' ? 'not-found' : 'failed',
      }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr }));

    // Программа может закрыться, не дочитав stdin (EPIPE) — это не ошибка запуска.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
