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
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { run } from './run.js';
import { programDescription, toolOptionDescription } from './cli-text.js';
import { askApiKey, askTool } from './core/prompt.js';
import type { Scope } from './adapters/types.js';

interface CliOptions {
  tool?: string;
  scope: Scope;
  model?: string;
  nonInteractive?: boolean;
  verify?: boolean;
}

/**
 * Версия для `--version` читается из package.json, а НЕ дублируется литералом:
 * литерал уже разъезжался с реальной версией пакета (застрял на 0.4.0 к релизу
 * 0.4.3). Путь верен и из dist/cli.js, и из src/cli.ts — package.json лежит на
 * уровень выше обоих, и npm всегда кладёт его в тарбол.
 */
const pkgVersion = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

const program = new Command();
program
  .name('joingonka-setup')
  // Число и список инструментов — из реестра (cli-text.ts), а не литералом: так
  // `--help` не отстаёт от реестра при добавлении адаптера.
  .description(programDescription())
  .version(pkgVersion)
  .option('--tool <tool>', toolOptionDescription())
  .option('--scope <scope>', 'Installation scope: user or local', 'user')
  .option(
    '--model <model>',
    'Model id, or "minimax" / "deepseek" / "glm" shortcuts ' +
      '(default: DeepSeek-V4-Flash where the installer writes the model, MiniMax-M2.7 elsewhere)',
  )
  .option(
    '--non-interactive',
    'Do not prompt; read the API key from JOINGONKA_API_KEY env var',
  )
  .option('--no-verify', 'Skip the post-setup live check against the gateway')
  .action(async (opts: CliOptions) => {
    try {
      const { result, verification, modelWarning } = await run(
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
      if (modelWarning) {
        console.warn(`! ${modelWarning}`);
      }

      // Результат live-проверки (если не отключена через --no-verify).
      if (verification) {
        console.log('');
        if (verification.ok) {
          console.log('✓ Verified: the gateway accepted the key, base URL and model.');
        } else if (verification.outcome === 'unavailable') {
          // Настройка корректна, занята сеть (или пуст баланс) — это НЕ провал
          // установки, поэтому выходим с нулевым кодом.
          console.warn(`! Could not verify right now (${verification.detail}).`);
          console.warn(
            '  The config is written and looks correct — this is a temporary ' +
              'condition on the network side. Check https://gate.joingonka.ai/status',
          );
        } else {
          console.error(`✗ Verification FAILED (${verification.detail}).`);
          console.error(
            '  The config was written, but a real request did not succeed — ' +
              'check the API key and the model id.',
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
