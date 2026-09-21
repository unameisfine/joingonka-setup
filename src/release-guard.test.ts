/**
 * Тесты гейта публикации scripts/check-clean-tree.mjs (его зовёт prepublishOnly).
 *
 * Правило: публикуем только из чистого закоммиченного дерева. `tsc` собирает
 * ВСЁ, что лежит в src/, поэтому незакоммиченная правка и даже новый
 * неотслеживаемый файл молча уезжают в npm, а в репозитории их нет — версию
 * потом нечем воспроизвести. Неотслеживаемые файлы — главный случай: именно их
 * не видит `git diff --quiet HEAD`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-clean-tree.mjs');

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

const runGuard = () => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'joingonka-guard-'));
  git('init', '-q');
  // Хуки окружения разработчика (commit-msg и т.п.) к тесту отношения не имеют.
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('check-clean-tree', () => {
  it('passes on a clean committed tree', () => {
    const result = runGuard();
    expect(result.status).toBe(0);
  });

  it('blocks an uncommitted change and names the file', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a.txt');
    expect(result.stderr).toMatch(/commit/i);
  });

  it('blocks a staged but uncommitted change', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git('add', 'a.txt');
    expect(runGuard().status).toBe(1);
  });

  it('blocks a NEW untracked file — the case `git diff --quiet HEAD` misses', () => {
    writeFileSync(join(repo, 'new-adapter.ts'), 'export {};\n');
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new-adapter.ts');
  });

  it('ignores files that git ignores (dist/, node_modules/)', () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore');
    execFileSync('mkdir', ['-p', join(repo, 'dist')]);
    writeFileSync(join(repo, 'dist', 'cli.js'), '// build output\n');
    expect(runGuard().status).toBe(0);
  });

  it('fails loudly outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'joingonka-guard-plain-'));
    try {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: plain,
        encoding: 'utf8',
        // Иначе git поднимется к репозиторию выше tmp-каталога, если он там есть.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(plain) },
      });
      expect(result.status).toBe(1);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
