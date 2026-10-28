/**
 * Итог установки для терминала: строки и код выхода (report.ts).
 *
 * ★ Повод (0.5.2): live-проверка ходит прямо в шлюз и печатала «✓ Verified», хотя
 * OpenCode 2 ключа не видел и запросы уходили без него. Теперь у адаптера есть
 * своя проверка тем, что видит сам инструмент (`toolCheck`), и «✓ Verified» при
 * её провале не печатается.
 */
import { describe, it, expect } from 'vitest';
import { verificationReport } from './report.js';
import type { ToolCheck } from './adapters/types.js';
import type { VerifyResult } from './core/verify.js';

const gatewayOk: VerifyResult = { ok: true, outcome: 'ok', status: 200, detail: 'gateway responded OK' };
const gatewayBusy: VerifyResult = { ok: false, outcome: 'unavailable', status: 429, detail: 'HTTP 429: busy' };
const gatewayRejected: VerifyResult = { ok: false, outcome: 'config', status: 401, detail: 'HTTP 401: bad key' };

const toolOk: ToolCheck = {
  status: 'ok',
  detail: 'OpenCode 2 sees the key: `opencode auth list` shows JoinGonka (Gonka) as stored.',
};
const toolMissing: ToolCheck = {
  status: 'missing',
  detail: 'OpenCode 2 (opencode v2.2.0) does not see the JoinGonka key yet: `opencode auth import` failed (boom).',
  fix: 'Fix: run `opencode auth login joingonka` and paste your key.',
};
const toolUnknown: ToolCheck = {
  status: 'unknown',
  detail: 'The opencode command was not found, so the OpenCode 2 key store was not checked.',
  fix: 'If you use OpenCode 2, run `opencode auth login joingonka` and paste your key.',
};

const texts = (report: ReturnType<typeof verificationReport>) => report.lines.map((line) => line.text);
const VERIFIED = /✓ Verified/;

describe('verificationReport', () => {
  it('gateway OK and no check of its own in the tool: ✓ Verified, exit 0 (as before)', () => {
    const report = verificationReport(gatewayOk, undefined);
    expect(texts(report)).toContain('✓ Verified: the gateway accepted the key, base URL and model.');
    expect(report.exitCode).toBe(0);
  });

  it('gateway OK but the tool does not see the key: no ✓ Verified — a warning with the fix', () => {
    const report = verificationReport(gatewayOk, toolMissing);

    expect(texts(report).some((text) => VERIFIED.test(text))).toBe(false);
    const warnings = report.lines.filter((line) => line.stream === 'warn').map((line) => line.text);
    expect(warnings.join('\n')).toContain(toolMissing.detail);
    expect(warnings.join('\n')).toContain('`opencode auth login joingonka`');
    expect(warnings.join('\n')).toMatch(/gateway accepted the key/);
    expect(report.exitCode).toBe(0);
  });

  it('gateway OK and the tool sees the key: both confirmations', () => {
    const report = verificationReport(gatewayOk, toolOk);
    expect(texts(report)).toContain('✓ Verified: the gateway accepted the key, base URL and model.');
    expect(texts(report)).toContain(`✓ ${toolOk.detail}`);
    expect(report.exitCode).toBe(0);
  });

  it('a rejected key stays a failure with exit code 2, whatever the tool says', () => {
    const report = verificationReport(gatewayRejected, toolOk);
    expect(texts(report).join('\n')).toContain('✗ Verification FAILED (HTTP 401: bad key)');
    expect(report.exitCode).toBe(2);
  });

  it('a busy network is a warning with exit code 0 (as before)', () => {
    const report = verificationReport(gatewayBusy, undefined);
    expect(texts(report).join('\n')).toContain('! Could not verify right now (HTTP 429: busy)');
    expect(report.exitCode).toBe(0);
  });

  it('--no-verify: the tool’s own check is still reported', () => {
    const report = verificationReport(undefined, toolMissing);
    expect(texts(report).join('\n')).toContain(toolMissing.detail);
    expect(texts(report).join('\n')).toContain(toolMissing.fix!);
    expect(report.exitCode).toBe(0);
  });

  it('the tool could not be checked: ✓ Verified is about the gateway and stays, the hint follows', () => {
    const report = verificationReport(gatewayOk, toolUnknown);
    expect(texts(report)).toContain('✓ Verified: the gateway accepted the key, base URL and model.');
    expect(texts(report).join('\n')).toContain(toolUnknown.fix!);
  });

  it('nothing to report: no lines at all', () => {
    expect(verificationReport(undefined, undefined)).toEqual({ lines: [], exitCode: 0 });
  });
});
