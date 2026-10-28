/**
 * OpenCode 2: распознавание версии и ключ в собственном хранилище OpenCode 2.
 *
 * CLI OpenCode подделан (testing/fake-opencode.ts) по ответам настоящего
 * OpenCode 2.2.0 и 1.19.4, снятым 28.10.2026. Главные свойства:
 *   - import зовётся только для V2, ключ уходит через stdin и никогда — в аргументы;
 *   - прежняя наша запись снимается до import (import её не заменяет);
 *   - итог проверяется тем, что видит сам OpenCode (`auth list` + `auth export`),
 *     а не кодами выхода.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunCommand } from '../core/commands.js';
import { fakeOpencode, noCommands, type FakeCredential } from '../testing/fake-opencode.js';
import {
  OPENCODE2_CREDENTIAL_ID,
  detectOpencode,
  parseOpencodeVersion,
  storeKeyInOpencode2,
  syncOpencodeKeystore,
} from './opencode-v2.js';

const KEY = 'jg-new0123456789abcdef0123456789abcdef';
const V2 = { bin: 'opencode', version: '2.2.0' };

/** Наша запись, оставленная прошлым запуском установщика. */
const ours = (key: string, active: boolean | null = true): FakeCredential => ({
  id: OPENCODE2_CREDENTIAL_ID,
  label: 'JoinGonka (Gonka)',
  key,
  active,
});

describe('parseOpencodeVersion', () => {
  it('reads both spellings: "opencode v2.2.0" (V2) and "1.19.4" (V1)', () => {
    expect(parseOpencodeVersion('opencode v2.2.0\n')).toBe('2.2.0');
    expect(parseOpencodeVersion('1.19.4\n')).toBe('1.19.4');
    expect(parseOpencodeVersion('opencode v2.10.3-beta.1')).toBe('2.10.3');
  });

  it('returns null when there is no version in the output', () => {
    expect(parseOpencodeVersion('Usage: opencode [flags]')).toBeNull();
    expect(parseOpencodeVersion('')).toBeNull();
  });
});

describe('detectOpencode', () => {
  it('finds OpenCode 2 under its usual name', async () => {
    const fake = fakeOpencode({ opencodeVersion: 'opencode v2.2.0' });
    expect(await detectOpencode(fake.run)).toEqual({ kind: 'v2', bin: 'opencode', version: '2.2.0' });
  });

  it('finds OpenCode 2 as `opencode2` when `opencode` is still 1.x — and remembers the 1.x next to it', async () => {
    const fake = fakeOpencode({ opencodeVersion: '1.19.4', opencode2Version: 'opencode v2.2.0' });
    expect(await detectOpencode(fake.run)).toEqual({
      kind: 'v2',
      bin: 'opencode2',
      version: '2.2.0',
      alongsideV1: '1.19.4',
    });
  });

  it('recognises OpenCode 1.x', async () => {
    const fake = fakeOpencode({ opencodeVersion: '1.19.4' });
    expect(await detectOpencode(fake.run)).toEqual({ kind: 'v1', version: '1.19.4' });
  });

  it('reports "none" when OpenCode is not installed', async () => {
    const found = await detectOpencode(noCommands);
    expect(found.kind).toBe('none');
    expect(found.kind === 'none' && found.reason).toMatch(/not found/i);
  });

  it('reports "none" for output it cannot read, quoting it', async () => {
    const fake = fakeOpencode({ opencodeVersion: 'something odd', opencode2Version: null });
    const found = await detectOpencode(fake.run);
    expect(found.kind).toBe('none');
    expect(found.kind === 'none' && found.reason).toContain('something odd');
  });

  it('does not take an unrelated 0.x `opencode` (the old Go tool) for OpenCode', async () => {
    const fake = fakeOpencode({ opencodeVersion: '0.0.55', opencode2Version: null });
    expect((await detectOpencode(fake.run)).kind).toBe('none');
  });

  it('only asks for the version — the key store is not touched', async () => {
    const fake = fakeOpencode({ opencodeVersion: '1.19.4', opencode2Version: 'opencode v2.2.0' });
    await detectOpencode(fake.run);
    expect(fake.calls.every((c) => c.args.join(' ') === '--version')).toBe(true);
  });
});

describe('storeKeyInOpencode2', () => {
  it('fresh store: reloads the config, imports the key, makes it active and checks what OpenCode sees', async () => {
    const fake = fakeOpencode();

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.subcommands()).toEqual([
      'service status',
      'reload',
      'auth list --format json',
      'auth import',
      'auth switch joingonka cred_joingonka',
      'auth list --format json',
      'auth export joingonka',
    ]);
    expect(fake.state.credentials).toEqual([ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
    expect(toolCheck.detail).toContain('`opencode auth list`');
    expect(toolCheck.detail).toMatch(/stored/);
  });

  it('no background service yet: works through a private server and leaves no service behind', async () => {
    // Иначе первая же команда подняла бы фоновый сервис с окружением установщика
    // (npx), и он обслуживал бы потом сессии пользователя.
    const fake = fakeOpencode({ serviceRunning: false });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.subcommands()).toEqual([
      'service status',
      'auth list --format json --standalone',
      'auth import --standalone',
      'auth switch joingonka cred_joingonka --standalone',
      'auth list --format json --standalone',
      'auth export joingonka --standalone',
    ]);
    expect(fake.state.serviceRunning).toBe(false);
    expect(fake.state.credentials).toEqual([ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
  });

  it('no background service yet, an earlier key in the store: replaced all the same', async () => {
    const fake = fakeOpencode({ serviceRunning: false, credentials: [ours('jg-old-key-from-the-last-run')] });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.subcommands()).toContain('auth logout joingonka cred_joingonka --standalone');
    expect(fake.state.credentials).toEqual([ours(KEY)]);
    expect(fake.state.serviceRunning).toBe(false);
    expect(toolCheck.status).toBe('ok');
  });

  it('an unreadable `service status` means: go through the service, as OpenCode itself would', async () => {
    const fake = fakeOpencode({ failing: { status: 'boom' } });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.subcommands().slice(0, 2)).toEqual(['service status', 'reload']);
    expect(toolCheck.status).toBe('ok');
  });

  it('hands the key over through stdin only — never as a command-line argument', async () => {
    const fake = fakeOpencode();

    await storeKeyInOpencode2(fake.run, V2, KEY);

    for (const call of fake.calls) {
      expect(call.args.join(' '), call.args.join(' ')).not.toContain(KEY);
    }
    const imported = fake.calls.find((c) => c.args.join(' ') === 'auth import');
    expect(JSON.parse(imported!.input!)).toEqual([
      {
        id: 'cred_joingonka',
        integrationID: 'joingonka',
        label: 'JoinGonka (Gonka)',
        active: true,
        value: { type: 'key', key: KEY },
      },
    ]);
  });

  it('replaces the key of an earlier run: import alone would skip it as "already present"', async () => {
    const fake = fakeOpencode({ credentials: [ours('jg-old-key-from-the-last-run')] });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    const steps = fake.subcommands();
    expect(steps.indexOf('auth logout joingonka cred_joingonka')).toBeGreaterThan(-1);
    expect(steps.indexOf('auth logout joingonka cred_joingonka')).toBeLessThan(steps.indexOf('auth import'));
    expect(fake.state.credentials).toEqual([ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
  });

  it('reloads first: a running service does not see the provider written a moment ago', async () => {
    // Без reload сервис отвечает на logout «Integration not found» — и прежний
    // ключ остался бы на месте (так ведёт себя настоящий OpenCode 2.2.0).
    const fake = fakeOpencode({ credentials: [ours('jg-old-key-from-the-last-run')], providerVisible: false });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.subcommands().slice(0, 2)).toEqual(['service status', 'reload']);
    expect(fake.state.credentials).toEqual([ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
  });

  it('keeps another JoinGonka account (a manual `auth login`) but makes ours the active one', async () => {
    const manual: FakeCredential = { id: 'cred_18038e7e00013p5JtTcCf9kqyB', label: 'JoinGonka (Gonka)', key: 'jg-typed-by-hand', active: true };
    const fake = fakeOpencode({ credentials: [manual] });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.state.credentials).toEqual([{ ...manual, active: false }, ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
  });

  it('works next to the record migrated from auth.json (label "API key", active null)', async () => {
    const migrated: FakeCredential = { id: 'cred_18036958b0012GlR3UbjYvoJsE', label: 'API key', key: 'jg-from-auth-json', active: null };
    const fake = fakeOpencode({ credentials: [migrated] });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

    expect(fake.state.credentials).toEqual([{ ...migrated, active: false }, ours(KEY)]);
    expect(toolCheck.status).toBe('ok');
  });

  it('uses the binary it was given for every call — `opencode2` included', async () => {
    const fake = fakeOpencode({ opencodeVersion: '1.19.4', opencode2Version: 'opencode v2.2.0' });

    const { toolCheck } = await storeKeyInOpencode2(fake.run, { bin: 'opencode2', version: '2.2.0' }, KEY);

    expect(fake.calls.every((c) => c.command === 'opencode2')).toBe(true);
    expect(toolCheck.status).toBe('ok');
    expect(toolCheck.detail).toContain('`opencode2 auth list`');
  });

  describe('when OpenCode 2 does not end up with the key', () => {
    const expectMissing = (toolCheck: { status: string; detail: string; fix?: string }, bin = 'opencode') => {
      expect(toolCheck.status).toBe('missing');
      expect(toolCheck.detail).toMatch(/does not see the JoinGonka key/);
      expect(toolCheck.fix).toContain(`\`${bin} auth login joingonka\``);
      expect(`${toolCheck.detail} ${toolCheck.fix}`).not.toContain(KEY);
    };

    it('a failed import is reported with its reason — and the key is masked even if the tool echoes it', async () => {
      const fake = fakeOpencode({ failing: { import: `Invalid credential value ${KEY}` } });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toContain('Invalid credential value');
    });

    it('the previous key could not be removed', async () => {
      const fake = fakeOpencode({ credentials: [ours('jg-old')], failing: { logout: 'database is locked' } });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toContain('database is locked');
      expect(fake.subcommands()).not.toContain('auth import');
    });

    it('the key could not be made active', async () => {
      const fake = fakeOpencode({ failing: { switch: 'switch broke' } });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toContain('switch broke');
    });

    it('`auth list` does not show it afterwards', async () => {
      const fake = fakeOpencode({ failing: { list: 'list broke' } });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toContain('auth list');
    });

    it('import skipped our record as "already present" (code 0 all the same)', async () => {
      // logout ответил успехом, но запись осталась — import её не заменяет.
      const fake = fakeOpencode({ credentials: [ours('jg-old-key-from-the-last-run')], logoutKeepsRecord: true });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toContain('skipped 1 already present');
    });

    it('OpenCode holds a different key than the one handed over, although every command reported success', async () => {
      // Проверка по факту (`auth export`), а не по кодам выхода и текстам команд.
      const fake = fakeOpencode();
      const tampering: RunCommand = async (command, args, options) => {
        const result = await fake.run(command, args, options);
        if (args.join(' ') === 'auth import') fake.state.credentials[0]!.key = 'jg-someone-else';
        return result;
      };

      const { toolCheck } = await storeKeyInOpencode2(tampering, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toMatch(/different JoinGonka key/);
    });

    it('our record ended up inactive', async () => {
      const fake = fakeOpencode();
      const deactivating: RunCommand = async (command, args, options) => {
        const result = await fake.run(command, args, options);
        if (args[1] === 'switch') fake.state.credentials[0]!.active = false;
        return result;
      };

      const { toolCheck } = await storeKeyInOpencode2(deactivating, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toMatch(/another JoinGonka account is active/);
    });

    it('stops at once when the OpenCode service does not answer', async () => {
      const fake = fakeOpencode();
      const hanging: RunCommand = async (command, args, options) =>
        args[0] === 'reload' ? { code: null, stdout: '', stderr: '', error: 'timeout' } : fake.run(command, args, options);

      const { toolCheck } = await storeKeyInOpencode2(hanging, V2, KEY);

      expectMissing(toolCheck);
      expect(toolCheck.detail).toMatch(/timed out/);
      expect(fake.subcommands()).toEqual(['service status']);
    });

    it('names the binary that holds OpenCode 2 in the fix', async () => {
      const fake = fakeOpencode({
        opencodeVersion: '1.19.4',
        opencode2Version: 'opencode v2.2.0',
        failing: { import: 'boom' },
      });

      const { toolCheck } = await storeKeyInOpencode2(fake.run, { bin: 'opencode2', version: '2.2.0' }, KEY);

      expectMissing(toolCheck, 'opencode2');
    });
  });
});

describe('syncOpencodeKeystore', () => {
  it('OpenCode 2: stores the key and says so', async () => {
    const fake = fakeOpencode();

    const sync = await syncOpencodeKeystore(fake.run, KEY);

    expect(sync.toolCheck?.status).toBe('ok');
    expect(sync.messages.join('\n')).toMatch(/OpenCode 2/);
    expect(fake.state.credentials).toEqual([ours(KEY)]);
  });

  it('OpenCode 1.x: nothing is imported — it reads auth.json', async () => {
    const fake = fakeOpencode({ opencodeVersion: '1.19.4' });

    const sync = await syncOpencodeKeystore(fake.run, KEY);

    expect(fake.subcommands()).toEqual([]);
    expect(sync.toolCheck).toBeUndefined();
    expect(sync.messages.join('\n')).toMatch(/1\.19\.4.*auth\.json/);
  });

  it('OpenCode not installed: no failure, a hint for OpenCode 2 instead', async () => {
    const sync = await syncOpencodeKeystore(noCommands, KEY);

    expect(sync.toolCheck?.status).toBe('unknown');
    expect(sync.toolCheck?.fix).toContain('`opencode auth login joingonka`');
  });

  describe('`opencode` is 1.x, OpenCode 2 sits next to it as `opencode2`', () => {
    // ★ Проверено 28.10.2026: базу, которую OpenCode 2 создал первым, OpenCode 1.19.4 не
    // открывает («Database is not empty and has no session table») и не запускается.
    // Базу, созданную 1.x, OpenCode 2 переносит на месте, и 1.x работает дальше.
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'joingonka-oc2-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const mixed = (dbPath: string) =>
      fakeOpencode({ opencodeVersion: '1.19.4', opencode2Version: 'opencode v2.2.0', dbPath });

    it('no database yet: OpenCode 2 is left alone — creating its database would stop 1.x from starting', async () => {
      const fake = mixed(join(dir, 'opencode.db'));

      const sync = await syncOpencodeKeystore(fake.run, KEY);

      expect(fake.subcommands()).toEqual(['debug paths db']);
      expect(fake.state.serviceRunning).toBe(true); // сервис не трогали (он и так «запущен» по умолчанию)
      expect(sync.toolCheck?.status).toBe('unknown');
      expect(sync.toolCheck?.detail).toMatch(/1\.19\.4/);
      expect(sync.toolCheck?.fix).toContain('`opencode2 auth login joingonka`');
    });

    it('the database already exists (1.x created it): the key goes into OpenCode 2', async () => {
      const dbPath = join(dir, 'opencode.db');
      writeFileSync(dbPath, '');
      const fake = mixed(dbPath);

      const sync = await syncOpencodeKeystore(fake.run, KEY);

      expect(fake.subcommands()).toContain('auth import');
      expect(fake.calls.filter((c) => c.args[0] !== '--version').every((c) => c.command === 'opencode2')).toBe(true);
      expect(sync.toolCheck?.status).toBe('ok');
    });

    it('the database path cannot be learned: OpenCode 2 is left alone as well', async () => {
      const fake = fakeOpencode({ opencodeVersion: '1.19.4', opencode2Version: 'opencode v2.2.0', dbPath: '' });

      const sync = await syncOpencodeKeystore(fake.run, KEY);

      expect(fake.subcommands()).toEqual(['debug paths db']);
      expect(sync.toolCheck?.status).toBe('unknown');
    });
  });

  it('without a command runner (adapter called directly) nothing is run, and the hint is the same', async () => {
    const sync = await syncOpencodeKeystore(undefined, KEY);

    expect(sync.toolCheck?.status).toBe('unknown');
    expect(sync.toolCheck?.fix).toContain('`opencode auth login joingonka`');
  });
});
