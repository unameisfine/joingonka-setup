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
  verify?: boolean;
}

const program = new Command();
program
  .name('joingonka-setup')
  .description(
    'Point an agentic AI tool (Claude Code, OpenClaw, Cline, opencode, Aider, Kilo, Roo, Continue) at JoinGonka Gateway',
  )
  .version('0.2.0')
  .option(
    '--tool <tool>',
    'Tool: claude-code | openclaw | cline | opencode | aider | kilo | roo | continue',
  )
  .option('--scope <scope>', 'Installation scope: user or local', 'user')
  .option('--model <model>', 'Model id, or "kimi" for Kimi K2.6 (default: Qwen3-235B)')
  .option(
    '--non-interactive',
    'Do not prompt; read the API key from JOINGONKA_API_KEY env var',
  )
  .option('--no-verify', 'Skip the post-setup live check against the gateway')
  .action(async (opts: CliOptions) => {
    try {
      const { result, verification } = await run(
        {
          tool: opts.tool,
          scope: opts.scope,
          model: opts.model,
          nonInteractive: opts.nonInteractive,
          verify: opts.verify,
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

      // Результат live-проверки (если не отключена через --no-verify).
      if (verification) {
        console.log('');
        if (verification.ok) {
          console.log('✓ Verified: the gateway accepted the key, base URL and model.');
        } else {
          console.error(`✗ Verification FAILED (${verification.detail}).`);
          console.error(
            '  The config was written, but a real request did not succeed — ' +
              'check the API key, your network, and the model id.',
          );
          process.exit(2);
        }
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
