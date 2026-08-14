import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectCodexProjectConfig } from '../../src/worker/codex-config-guard.js';

const roots: string[] = [];

function fixture(config?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bridge-config-'));
  roots.push(root);
  if (config !== undefined) {
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), config, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex project configuration authority guard', () => {
  it('allows a bound worktree with no project configuration', () => {
    expect(inspectCodexProjectConfig(fixture())).toMatchObject({ allowed: true, inspectedFiles: [] });
  });

  it('allows explicitly classified non-authority settings', () => {
    const result = inspectCodexProjectConfig(fixture('[model]\nreasoning_effort = "high"\n'));
    expect(result.allowed).toBe(true);
  });

  it.each([
    ['[mcp_servers.test]\ncommand = "tool"\n', 'capability'],
    ['unknown_setting = true\n', 'unknown'],
    ['[unparseable\n', 'invalid'],
  ])('rejects %s as %s', (config, reasonWord) => {
    const result = inspectCodexProjectConfig(fixture(config));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(new RegExp(`PERMISSION_BLOCKED.*${reasonWord}`, 'i'));
  });

  it('rejects oversized configuration without changing its contents', () => {
    const config = 'model_reasoning_effort = "high"\n' + 'x'.repeat(70_000);
    const root = fixture(config);
    const file = path.join(root, '.codex', 'config.toml');
    const before = fs.readFileSync(file, 'utf8');
    const result = inspectCodexProjectConfig(root);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PERMISSION_BLOCKED.*oversized/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
