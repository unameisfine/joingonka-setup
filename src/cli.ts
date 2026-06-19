#!/usr/bin/env node
/**
 * CLI entry point для @joingonka/setup.
 *
 * Тонкая обёртка над run() из run.ts: парсинг аргументов, подключение
 * реальных промптов (core/prompt.ts) и обработка ошибок. Вся логика
 * установки — внутри run().
 *
 * Безопасность: ключ НИКОГДА не принимается CLI-аргументом. В интерактиве
 * он вводится password-промптом, в non-interactive — берётся из env
 * JOINGONKA_API_KEY. Аргумент командной строки попал бы в историю shell
 * и в список процессов — это утечка секрета.
 */
import { Command } from 'commander';
import { run } from './run.js';
import { askApiKey, askTool } from './core/prompt.js';
import type { Scope } from './adapters/types.js';

interface CliOptions {
  tool?: string;
  scope: Scope;
  model?: string;
  nonInteractive?: boolean;
}

const program = new Command();
program
  .name('joingonka-setup')
  .description(
    'Point an agentic AI tool (Claude Code, OpenClaw, Cline) at JoinGonka Gateway',
  )
  .version('0.1.0')
  .option('--tool <tool>', 'Tool to configure: claude-code | openclaw | cline')
  .option('--scope <scope>', 'Installation scope: user or local', 'user')
  .option('--model <model>', 'Model id, or "kimi" for Kimi K2.6 (default: Qwen3-235B)')
  .option(
    '--non-interactive',
    'Do not prompt; read the API key from JOINGONKA_API_KEY env var',
  )
  .action(async (opts: CliOptions) => {
    try {
      const { result } = await run(
        {
          tool: opts.tool,
          scope: opts.scope,
          model: opts.model,
          nonInteractive: opts.nonInteractive,
        },
        { askTool, askApiKey },
      );

      // Печатаем сообщения адаптера (пути/инструкции/подтверждения)
      console.log('');
      for (const line of result.messages) {
        console.log(line);
      }
      if (result.backupPath) {
        console.log(`Backup saved: ${result.backupPath}`);
      }
      process.exit(0);
    } catch (e) {
      // ExitPromptError выбрасывается @inquirer/prompts при Ctrl+C
      if (e instanceof Error && e.name === 'ExitPromptError') {
        console.error('\nAborted.');
        process.exit(130);
      }
      console.error('Setup failed:', (e as Error).message);
      process.exit(1);
    }
  });
program.parse();
