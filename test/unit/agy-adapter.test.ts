import { describe, it, expect } from 'vitest';
import { AgyAdapter, DEFAULT_AGY_PATH } from '../../src/worker/agy-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('AgyAdapter & Official AGY CLI Invariants', () => {
  const processManager = new ProcessManager();

  it('constructs official AGY CLI argument flags for PLAN mode', () => {
    const adapter = new AgyAdapter('agy.exe', 'gemini-3.7-flash-high', processManager);
    const planProfile = AgyAdapter.getPlanProfile();

    const args = adapter.buildInvocationArgs('Investigate codebase', 'C:\\worktree\\plan', planProfile);

    // Non-interactive print mode with prompt
    expect(args).toContain('-p');
    expect(args).toContain('Investigate codebase');

    // Model selection
    expect(args).toContain('--model');
    expect(args).toContain('gemini-3.7-flash-high');

    // Reasoning effort
    expect(args).toContain('--effort');
    expect(args).toContain('high');

    // Built-in plan mode
    expect(args).toContain('--mode');
    expect(args).toContain('plan');

    // Terminal sandbox enabled
    expect(args).toContain('--sandbox');

    // Add directory to workspace
    expect(args).toContain('--add-dir');
    expect(args).toContain('C:\\worktree\\plan');
  });

  it('constructs official AGY CLI argument flags for IMPLEMENT mode', () => {
    const adapter = new AgyAdapter('agy.exe', 'gemini-3.7-flash-high', processManager);
    const impProfile = AgyAdapter.getImplementProfile();

    const args = adapter.buildInvocationArgs('Implement code', 'C:\\worktree\\imp', impProfile);

    expect(args).toContain('-p');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-3.7-flash-high');
    expect(args).toContain('--effort');
    expect(args).toContain('high');

    // Built-in accept-edits mode
    expect(args).toContain('--mode');
    expect(args).toContain('accept-edits');

    // Terminal sandbox enabled
    expect(args).toContain('--sandbox');
    expect(args).toContain('--add-dir');
    expect(args).toContain('C:\\worktree\\imp');
  });

  it('detects and verifies the installed AGY CLI binary on the host', async () => {
    const adapter = new AgyAdapter(DEFAULT_AGY_PATH, 'gemini-3.7-flash-high', processManager);
    const check = await adapter.checkAgyInstalled();

    expect(check.installed).toBe(true);
    expect(check.version).toBeDefined();
    expect(check.version).toContain('1.1.13');
  });

  it('reports AGY_CLI_MISSING clearly when executable is not present', async () => {
    const adapter = new AgyAdapter('non_existent_agy_binary_xyz_123', 'gemini-3.7-flash-high', processManager);
    const check = await adapter.checkAgyInstalled();

    expect(check.installed).toBe(false);
    expect(check.error).toContain('AGY_CLI_MISSING');
  });
});
