/**
 * Адаптер Claude Code — JSON-конфиг settings.json.
 *
 * Прописываем блок `env`, который перенаправляет Claude Code на JoinGonka
 * Gateway и закрепляет за ним модель сети Gonka:
 *   ANTHROPIC_AUTH_TOKEN — наш jg-ключ (уходит как `Authorization: Bearer`)
 *   ANTHROPIC_BASE_URL   — BASE_URL (БЕЗ /v1; Claude сам добавит /v1/messages)
 *   ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_DEFAULT_{OPUS,SONNET,
 *   FABLE}_MODEL, CLAUDE_CODE_SUBAGENT_MODEL — выбранная модель Gonka
 *   ANTHROPIC_DEFAULT_HAIKU_MODEL — MiniMax: на haiku-алиасе висят фоновые
 *     задачи, а у MiniMax больше всего ёмкости в сети
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS / CLAUDE_CODE_MAX_OUTPUT_TOKENS — реальные
 *     окно и потолок ответа выбранной модели
 *
 * ★ Зачем закреплять модель и окно (дефект, найденный аудитом 19.09.2026).
 * Без ANTHROPIC_MODEL клиент шлёт свой дефолтный `claude-*`, а шлюз молча
 * подменяет его первой активной моделью сети: `--model deepseek` не действовал,
 * хотя live-проверка бодро подтверждала «Verified». Хуже другое: для
 * нераспознанного id Claude Code берёт СВОЁ представление об окне (до 1M) и не
 * сжимает историю, пока не упрётся, — а у моделей Gonka окно 200K/380K/390K,
 * и сессия ломалась переполнением контекста.
 * По доке (code.claude.com/docs/en/model-config, раздел «Correct the window for
 * a gateway or custom model ID») для id, который НЕ начинается с `claude-` и не
 * содержит `[1m]` — а все id Gonka такие, — `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 * применяется напрямую и упреждающее сжатие идёт по объявленному окну.
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
import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import {
  BASE_URL,
  DEFAULT_MODEL,
  CODING_AGENT_DEFAULT_MODEL,
  OPENCLAW_MODELS,
  OPENCLAW_CONTEXT_WINDOW,
} from '../constants.js';
import { readRaw, backup, atomicWrite } from '../core/fs-ops.js';
import { readJsonConfig, applyJsonEdits, type JsonEdit } from '../core/json-config.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

/**
 * Права на файл с ключом — только владелец (rw-------).
 * README обещал 600 с самого начала, но адаптер не передавал mode, и новый
 * settings.json создавался с 0644 (аудит 19.09.2026).
 */
const OWNER_ONLY_MODE = 0o600;

/** Разрешение пути: homedir()/cwd() читаются В МОМЕНТ ВЫЗОВА (тесты подменяют HOME/cwd). */
function resolvePath(scope: Scope): string {
  if (scope === 'user') {
    return join(homedir(), '.claude', 'settings.json');
  }
  return join(process.cwd(), '.claude', 'settings.local.json');
}

/** Характеристики модели из каталога установщика (undefined — id вне каталога). */
function specFor(model: string) {
  return OPENCLAW_MODELS.find((m) => m.id === model);
}

/**
 * Правки блока `env`. Чужие переменные пользователя не трогаем: адресуем
 * только свои ключи.
 */
function buildEdits(model: string): JsonEdit[] {
  const edits: JsonEdit[] = [
    { path: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: null }, // значение проставим ниже
    { path: ['env', 'ANTHROPIC_BASE_URL'], value: BASE_URL },
    // ANTHROPIC_MODEL читается первым и задаёт модель текущей сессии,
    // ANTHROPIC_DEFAULT_MODEL — модель, с которой стартуют новые сессии.
    { path: ['env', 'ANTHROPIC_MODEL'], value: model },
    { path: ['env', 'ANTHROPIC_DEFAULT_MODEL'], value: model },
    // Алиасы opus/sonnet/fable — на выбранную модель, haiku (фоновые задачи) —
    // на самую ёмкую модель сети.
    { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], value: model },
    { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], value: model },
    { path: ['env', 'ANTHROPIC_DEFAULT_FABLE_MODEL'], value: model },
    { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], value: DEFAULT_MODEL },
    { path: ['env', 'CLAUDE_CODE_SUBAGENT_MODEL'], value: model },
  ];

  // Окно и потолок ответа — только для моделей каталога: для незнакомого id мы
  // их не знаем, и врать Claude Code хуже, чем промолчать.
  const spec = specFor(model);
  if (spec) {
    edits.push(
      {
        path: ['env', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'],
        value: String(spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW),
      },
      { path: ['env', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'], value: String(spec.maxTokens) },
    );
  }

  return edits;
}

/**
 * `--scope local` кладёт ключ в файл внутри проекта. Claude Code игнорирует
 * такой файл в git сам по себе только когда создаёт его сам, поэтому проверяем
 * и при необходимости дописываем строку в .gitignore — иначе ключ легко уедет
 * в коммит.
 *
 * Возвращает сообщение пользователю (или null, если вмешательство не нужно).
 */
function ensureGitIgnored(configPath: string): string | null {
  const projectDir = process.cwd();
  const relative = '.claude/settings.local.json';

  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      stdio: 'ignore',
    });
  } catch {
    return null; // не git-репозиторий — игнорировать нечего
  }

  try {
    execFileSync('git', ['check-ignore', '-q', configPath], { cwd: projectDir, stdio: 'ignore' });
    return null; // уже игнорируется
  } catch {
    /* не игнорируется — дописываем правило ниже */
  }

  const gitignorePath = join(projectDir, '.gitignore');
  try {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${relative}\n`);
    return `Added ${relative} to .gitignore — the file contains your API key.`;
  } catch {
    return `WARNING: ${relative} holds your API key and is NOT ignored by git — add it to .gitignore.`;
  }
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  const configPath = resolvePath(input.scope);

  // Читаем ДО бэкапа: settings.json может быть JSONC с комментариями, а
  // неразбираемый файл означает отказ без записи (раньше он заменялся пустым).
  const doc = readJsonConfig(readRaw(configPath), configPath);
  const backupPath = backup(configPath);

  const edits = buildEdits(input.model);
  edits[0] = { path: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: input.apiKey };

  // Файл содержит ключ → 0o600 (owner-only), как у остальных адаптеров.
  await atomicWrite(configPath, applyJsonEdits(doc.text, edits), OWNER_ONLY_MODE);

  const spec = specFor(input.model);
  const messages = [
    `Configured ${configPath}`,
    `Base URL: ${BASE_URL}`,
    `Model: ${input.model}`,
  ];
  if (spec) {
    messages.push(
      `Context window: ${spec.contextWindow ?? OPENCLAW_CONTEXT_WINDOW} tokens, ` +
        `max output: ${spec.maxTokens} — declared to Claude Code so it compacts in time.`,
    );
  }
  if (input.scope === 'local') {
    const note = ensureGitIgnored(configPath);
    if (note) messages.push(note);
  }
  messages.push('Restart Claude Code to apply the new configuration.');

  return { configPath, backupPath, wrote: true, messages };
}

export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code (Anthropic API)',
  format: 'json',
  apiMode: 'anthropic', // live-проверка идёт на /v1/messages (x-api-key), не /v1/chat/completions
  // Единственный инструмент с конфигом внутри проекта: .claude/settings.local.json.
  supportsLocalScope: true,
  // Кодовый агент: длинный контекст и потолок ответа важнее универсальности.
  defaultModel: CODING_AGENT_DEFAULT_MODEL,
  resolvePath,
  apply,
};
