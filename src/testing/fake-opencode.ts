/**
 * Поддельный CLI OpenCode для тестов.
 *
 * Повторяет поведение, снятое вживую 28.10.2026 с OpenCode 2.2.0 (npm `@opencode/cli`)
 * и 1.19.4 (npm `opencode-ai`) — подробности в шапке adapters/opencode-v2.ts. Тексты
 * ответов — дословные строки настоящего CLI. В сборку не попадает: каталог
 * src/testing исключён в tsconfig.json.
 */
import type { CommandOptions, CommandResult, RunCommand } from '../core/commands.js';

/** Запись хранилища ключей OpenCode 2 (таблица `credential`). */
export interface FakeCredential {
  id: string;
  label: string;
  key: string;
  /** null — так выглядит запись, перенесённая миграцией из auth.json. */
  active: boolean | null;
}

/** Один вызов программы — с тем, что ушло в stdin. */
export interface CommandCall {
  command: string;
  args: string[];
  input?: string;
}

/** Подкоманды, которые тест может заставить упасть. */
export type FakeSubcommand = 'status' | 'reload' | 'list' | 'logout' | 'import' | 'switch' | 'export';

export interface FakeOpencodeOptions {
  /** Что печатает `opencode --version`; null — команды `opencode` нет. По умолчанию — V2. */
  opencodeVersion?: string | null;
  /**
   * Что печатает `opencode2 --version`; null — такой команды нет. По умолчанию —
   * то же, что у `opencode`, если это V2 (npm-пакет V2 ставит оба имени).
   */
  opencode2Version?: string | null;
  /** Записи, которые уже лежат в хранилище. */
  credentials?: FakeCredential[];
  /**
   * Фоновый сервис OpenCode 2 уже запущен. По умолчанию да. Не запущен — первая
   * команда без `--standalone` его поднимает (как настоящий CLI), а команда с
   * `--standalone` работает частным сервером и демона не оставляет.
   */
  serviceRunning?: boolean;
  /**
   * Сервис уже видит провайдера joingonka. По умолчанию нет — как у сервиса,
   * запущенного до записи конфига: видеть его он начинает после `opencode reload`.
   * Частный сервер (`--standalone`) читает конфиг заново и видит его всегда.
   */
  providerVisible?: boolean;
  /** Что печатает `opencode debug paths db` (путь к базе; самой базы команда не создаёт). */
  dbPath?: string;
  /** Подкоманда отвечает кодом 1 с этим текстом и ничего не меняет. */
  failing?: Partial<Record<FakeSubcommand, string>>;
  /** `auth logout` отвечает успехом, но запись оставляет (проверка по факту, а не по коду). */
  logoutKeepsRecord?: boolean;
}

const PROVIDER = 'joingonka';
const PROVIDER_NAME = 'JoinGonka (Gonka)';
const V2_DEFAULT = 'opencode v2.2.0';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stdout: string): CommandResult => ({ code: 1, stdout, stderr: '' });
const notFound = (command: string): CommandResult => ({
  code: null,
  stdout: '',
  stderr: `spawn ${command} ENOENT`,
  error: 'not-found',
});

/** Ответы clack-интерфейса настоящего CLI: рамка, значок, текст. */
const clack = (title: string, mark: '◇' | '■', text: string, last: 'Done' | 'Failed') =>
  `┌  ${title}\n│\n${mark}  ${text}\n│\n└  ${last}\n`;

const isV2 = (version: string | null | undefined) => typeof version === 'string' && /v2\./.test(version);

export function fakeOpencode(options: FakeOpencodeOptions = {}) {
  const calls: CommandCall[] = [];
  const opencodeVersion = options.opencodeVersion === undefined ? V2_DEFAULT : options.opencodeVersion;
  const opencode2Version =
    options.opencode2Version !== undefined
      ? options.opencode2Version
      : isV2(opencodeVersion)
        ? opencodeVersion
        : null;
  const state = {
    serviceRunning: options.serviceRunning ?? true,
    providerVisible: options.providerVisible ?? false,
    credentials: (options.credentials ?? []).map((c) => ({ ...c })),
  };

  const versions: Record<string, string | null> = { opencode: opencodeVersion, opencode2: opencode2Version };

  function v2(args: string[], input: string | undefined): CommandResult {
    const standalone = args.includes('--standalone');
    const sub = args.filter((arg) => arg !== '--standalone');
    const [first, second, target, credential] = sub;

    if (first === 'service' && second === 'status') {
      const why = options.failing?.status;
      if (why !== undefined) return fail(why);
      return ok(state.serviceRunning ? 'http://127.0.0.1:49374\n' : 'stopped\n');
    }
    // Путь к базе: сервис не поднимается, база не создаётся; --standalone команда не знает.
    if (first === 'debug' && second === 'paths') {
      if (standalone) return fail('ERROR\n  Unrecognized flag: --standalone in command opencode debug paths\n');
      return ok(`${options.dbPath ?? '/nonexistent/opencode/opencode.db'}\n`);
    }
    // Любая другая команда без --standalone поднимает фоновый сервис.
    if (!standalone) state.serviceRunning = true;
    const visibleBefore = state.providerVisible;
    if (standalone) state.providerVisible = true;
    try {
      return command(first, second, target, credential, input);
    } finally {
      if (standalone) state.providerVisible = visibleBefore;
    }
  }

  function command(
    first: string | undefined,
    second: string | undefined,
    target: string | undefined,
    credential: string | undefined,
    input: string | undefined,
  ): CommandResult {
    const failing = (name: FakeSubcommand) => options.failing?.[name];

    if (first === 'reload') {
      const why = failing('reload');
      if (why !== undefined) return fail(why);
      state.providerVisible = true;
      return ok('Configuration reloaded\n');
    }
    if (first !== 'auth') return fail(`Unknown command: ${first}\n`);

    switch (second) {
      case 'list': {
        const why = failing('list');
        if (why !== undefined) return fail(why);
        // Интеграция видна только при провайдере в конфиге и хотя бы одной записи.
        if (!state.providerVisible || state.credentials.length === 0) return ok('[]\n');
        const listed = [
          {
            id: PROVIDER,
            name: PROVIDER_NAME,
            connections: state.credentials.map((c) => ({
              type: 'credential',
              id: c.id,
              label: c.label,
              method: 'key',
            })),
          },
        ];
        return ok(`${JSON.stringify(listed, null, 2)}\n`);
      }
      case 'logout': {
        const why = failing('logout');
        if (why !== undefined) return fail(why);
        if (!state.providerVisible || target !== PROVIDER) {
          return fail(clack('Log out of an account', '■', `Integration not found: ${target}`, 'Failed'));
        }
        const index = state.credentials.findIndex((c) => c.id === credential);
        if (index < 0) {
          return fail(
            clack('Log out of an account', '■', `Credential not found for ${PROVIDER_NAME}: ${credential}`, 'Failed'),
          );
        }
        if (!options.logoutKeepsRecord) state.credentials.splice(index, 1);
        return ok(clack('Log out of an account', '◇', `Removed account from ${PROVIDER_NAME}`, 'Done'));
      }
      case 'import': {
        const why = failing('import');
        if (why !== undefined) return fail(why);
        let records: unknown;
        try {
          records = JSON.parse(input ?? '');
        } catch {
          return fail('Expected a valid JSON string\n');
        }
        if (!Array.isArray(records)) return fail('Expected an array\n');
        let imported = 0;
        let skipped = 0;
        for (const [i, raw] of records.entries()) {
          const record = raw as { id?: string; label?: string; active?: boolean; value?: { key?: string } };
          if (typeof record.id !== 'string') return fail(`Missing key\n  at [${i}]["id"]\n`);
          // Повторный import с тем же id запись НЕ заменяет.
          if (state.credentials.some((c) => c.id === record.id)) {
            skipped += 1;
            continue;
          }
          // Новая запись активна, только если у интеграции активной ещё нет.
          const othersActive = state.credentials.some((c) => c.active === true);
          state.credentials.push({
            id: record.id,
            label: record.label ?? '',
            key: record.value?.key ?? '',
            active: record.active === true && !othersActive,
          });
          imported += 1;
        }
        const noun = imported === 1 ? 'credential' : 'credentials';
        const tail = skipped > 0 ? `, skipped ${skipped} already present` : '';
        return ok(`Imported ${imported} ${noun}${tail}\n`);
      }
      case 'switch': {
        const why = failing('switch');
        if (why !== undefined) return fail(why);
        if (!state.providerVisible || target !== PROVIDER) {
          return fail(clack('Switch account', '■', `Integration not found: ${target}`, 'Failed'));
        }
        if (!state.credentials.some((c) => c.id === credential)) {
          return fail(clack('Switch account', '■', `Credential not found for ${PROVIDER_NAME}: ${credential}`, 'Failed'));
        }
        for (const c of state.credentials) c.active = c.id === credential;
        return ok(clack('Switch account', '◇', `Switched account for ${PROVIDER_NAME}`, 'Done'));
      }
      case 'export': {
        const why = failing('export');
        if (why !== undefined) return fail(why);
        if (!state.providerVisible || target !== PROVIDER) return fail(`Integration not found: ${target}\n`);
        const exported = state.credentials.map((c) => ({
          id: c.id,
          integrationID: PROVIDER,
          label: c.label,
          active: c.active === true,
          value: { type: 'key', key: c.key },
        }));
        return ok(`${JSON.stringify(exported, null, 2)}\n`);
      }
      default:
        return fail(`Unknown command: auth ${second}\n`);
    }
  }

  const run: RunCommand = async (command: string, args: readonly string[], opts?: CommandOptions) => {
    calls.push({ command, args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    const version = versions[command];
    if (version === undefined || version === null) return notFound(command);
    if (args[0] === '--version') return ok(`${version}\n`);
    if (!isV2(version)) return fail(`Unknown command: ${args.join(' ')}\n`);
    return v2([...args], opts?.input);
  };

  return {
    run,
    calls,
    state,
    /** Вызовы подкоманд (без `--version`) — что установщик делал с хранилищем. */
    subcommands: () => calls.filter((c) => c.args[0] !== '--version').map((c) => c.args.join(' ')),
  };
}

/** Ни одной внешней программы на машине — так выглядит и машина без OpenCode. */
export const noCommands: RunCommand = async (command: string) => notFound(command);
