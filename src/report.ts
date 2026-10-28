/**
 * Итог установки для терминала: строки и код выхода.
 *
 * Отдельно от cli.ts, чтобы правило «когда можно печатать ✓ Verified» держали тесты
 * (report.test.ts): cli.ts при импорте разбирает argv и завершает процесс.
 *
 * Два источника правды:
 *   - live-проверка шлюза (core/verify.ts) — приняты ли ключ, URL и модель;
 *   - проверка самим инструментом (`ApplyResult.toolCheck`) — видит ли он ключ.
 * ★ «✓ Verified» — только когда шлюз ответил 200 И инструмент не сказал, что ключа
 * не видит. До 0.5.2 печаталось по одному шлюзу: OpenCode 2 оставался без ключа, а
 * установщик рапортовал успех.
 */
import type { ToolCheck } from './adapters/types.js';
import type { VerifyResult } from './core/verify.js';

/** Куда печатать строку: console.log / console.warn / console.error. */
export type ReportStream = 'log' | 'warn' | 'error';

export interface ReportLine {
  stream: ReportStream;
  text: string;
}

export interface Report {
  lines: ReportLine[];
  /** 2 — шлюз отверг ключ, модель или URL; иначе 0. */
  exitCode: 0 | 2;
}

export function verificationReport(verification: VerifyResult | undefined, toolCheck: ToolCheck | undefined): Report {
  const lines: ReportLine[] = [];
  const log = (text: string) => lines.push({ stream: 'log', text });
  const warn = (text: string) => lines.push({ stream: 'warn', text });
  const error = (text: string) => lines.push({ stream: 'error', text });
  let exitCode: 0 | 2 = 0;

  if (verification !== undefined) {
    if (verification.ok) {
      if (toolCheck?.status === 'missing') {
        warn('! The gateway accepted the key, base URL and model, but the tool itself does not see the key yet:');
      } else {
        log('✓ Verified: the gateway accepted the key, base URL and model.');
      }
    } else if (verification.outcome === 'unavailable') {
      // Настройка корректна, занята сеть (или пуст баланс) — это НЕ провал
      // установки, поэтому код выхода нулевой.
      warn(`! Could not verify right now (${verification.detail}).`);
      warn(
        '  The config is written and looks correct — this is a temporary ' +
          'condition on the network side. Check https://gate.joingonka.ai/status',
      );
    } else {
      error(`✗ Verification FAILED (${verification.detail}).`);
      error(
        '  The config was written, but a real request did not succeed — ' +
          'check the API key and the model id.',
      );
      exitCode = 2;
    }
  }

  if (toolCheck !== undefined) {
    if (toolCheck.status === 'ok') {
      log(`✓ ${toolCheck.detail}`);
    } else {
      warn(`! ${toolCheck.detail}`);
      if (toolCheck.fix !== undefined) warn(`  ${toolCheck.fix}`);
    }
  }

  // Пустая строка отделяет итог от сообщений адаптера — если итог вообще есть.
  return { lines: lines.length > 0 ? [{ stream: 'log', text: '' }, ...lines] : [], exitCode };
}
