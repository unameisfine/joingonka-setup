/**
 * Адаптер Claude Code — JSON-конфиг.
 *
 * Цель: прописать в settings.json две переменные окружения, которые
 * перенаправляют Claude Code на JoinGonka Gateway:
 *   env.ANTHROPIC_AUTH_TOKEN — наш jg-ключ
 *   env.ANTHROPIC_BASE_URL   — BASE_URL (БЕЗ /v1; Claude сам добавит /v1/messages)
 *
 * Имя именно ANTHROPIC_AUTH_TOKEN (не _API_KEY) — паритет с уже
 * опубликованным пакетом @joingonka/claude-code. НЕ менять.
 *
 * Пути:
 *   user  → ~/.claude/settings.json
 *   local → <cwd>/.claude/settings.local.json
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BASE_URL } from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { mergeJson } from '../core/merge.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/** Разрешение пути: homedir()/cwd() читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/cwd). */
function resolvePath(scope: Scope): string {
  if (scope === 'user') {
    return join(homedir(), '.claude', 'settings.json');
  }
  return join(process.cwd(), '.claude', 'settings.local.json');
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем существующее (если есть) и бэкапим перед перезаписью.
  // Бэкап делаем ВСЕГДА при наличии файла — даже если JSON битый,
  // чтобы пользователь не потерял свои данные безвозвратно.
  const raw = readRaw(configPath);
  const backupPath = backup(configPath);

  let existing: unknown = {};
  if (raw != null) {
    try {
      existing = JSON.parse(raw);
    } catch {
      // Битый JSON → стартуем со свежего объекта (mergeJson отбросит не-объект)
      existing = {};
    }
  }

  const merged = mergeJson(existing, {
    env: {
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      ANTHROPIC_BASE_URL: BASE_URL,
    },
  });

  await atomicWrite(configPath, JSON.stringify(merged, null, 2) + '\n');

  return {
    configPath,
    backupPath,
    wrote: true,
    messages: [
      `Configured ${configPath}`,
      `Base URL: ${BASE_URL}`,
      'Restart Claude Code to apply the new configuration.',
    ],
  };
}

export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code (Anthropic API)',
  format: 'json',
  apiMode: 'anthropic', // live-проверка идёт на /v1/messages (x-api-key), не /v1/chat/completions
  resolvePath,
  apply,
};
