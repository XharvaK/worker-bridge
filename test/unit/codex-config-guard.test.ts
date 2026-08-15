import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashInspectedConfigs, inspectCodexProjectConfig } from '../../src/worker/codex-config-guard.js';

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
    ['model_reasoning_effort = "high\\q"\n', 'invalid'],
    ['model_reasoning_effort = "high"\nmodel_reasoning_effort = "low"\n', 'duplicate'],
  ])('rejects %s as %s', (config, reasonWord) => {
    const result = inspectCodexProjectConfig(fixture(config));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(new RegExp(`PERMISSION_BLOCKED.*${reasonWord}`, 'i'));
  });

  it('rejects a non-directory .codex path instead of treating it as absent', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, '.codex'), 'not a directory', 'utf8');

    const result = inspectCodexProjectConfig(root);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PERMISSION_BLOCKED.*(?:unreadable|metadata|directory|path)/i);
  });

  it('rejects a symlinked .codex path rather than following it', ({ skip }) => {
    const root = fixture();
    const external = fixture('[model]\nreasoning_effort = "high"\n');
    const linkPath = path.join(root, '.codex');
    try {
      fs.symlinkSync(path.join(external, '.codex'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      skip();
      return;
    }

    const result = inspectCodexProjectConfig(root);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PERMISSION_BLOCKED.*symlink/i);
  });

  it('inspects a configuration at the repository ancestor without leaving the bounded root', () => {
    const repositoryRoot = fixture();
    fs.mkdirSync(path.join(repositoryRoot, '.git'));
    fs.mkdirSync(path.join(repositoryRoot, '.codex'));
    const configPath = path.join(repositoryRoot, '.codex', 'config.toml');
    fs.writeFileSync(configPath, '[model]\nreasoning_effort = "high"\n', 'utf8');
    const worktree = path.join(repositoryRoot, 'nested', 'worktree');
    fs.mkdirSync(worktree, { recursive: true });

    const result = inspectCodexProjectConfig(worktree);

    expect(result.allowed).toBe(true);
    expect(result.inspectedFiles).toContain(configPath);
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

  it('computes stable hashes for inspected configs and detects changes', () => {
    const root = fixture('[model]\nreasoning_effort = "high"\n');
    const configPath = path.join(root, '.codex', 'config.toml');

    const hash1 = hashInspectedConfigs([configPath]);
    const hash2 = hashInspectedConfigs([configPath]);
    expect(hash1).toBeTruthy();
    expect(hash1).toBe(hash2);

    // Modify file
    fs.writeFileSync(configPath, '[model]\nreasoning_effort = "low"\n', 'utf8');
    const hashModified = hashInspectedConfigs([configPath]);
    expect(hashModified).not.toBe(hash1);

    // Empty inspected files
    const emptyHash1 = hashInspectedConfigs([]);
    const emptyHash2 = hashInspectedConfigs([]);
    expect(emptyHash1).toBe(emptyHash2);
  });
});
