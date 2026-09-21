/**
 * Тесты текстов CLI, которые считаются из реестра (src/cli-text.ts). Сверку с
 * README и package.json держит src/docs-guard.test.ts; здесь — сами строки.
 */
import { describe, it, expect } from 'vitest';
import { programDescription, toolOptionDescription } from './cli-text.js';
import { listTools } from './adapters/registry.js';

describe('cli-text', () => {
  it('counts the tools instead of quoting a number', () => {
    expect(programDescription()).toBe(
      `Point an agentic AI tool at JoinGonka Gateway (${listTools().length} tools supported)`,
    );
    expect(programDescription()).toContain('25 tools supported');
  });

  it('offers every tool of the menu in --tool, in the same order', () => {
    expect(toolOptionDescription()).toBe(`Tool: ${listTools().map((t) => t.value).join(' | ')}`);
    expect(toolOptionDescription().startsWith('Tool: claude-code | codex | opencode')).toBe(true);
    expect(toolOptionDescription().endsWith(' | roo')).toBe(true);
  });
});
