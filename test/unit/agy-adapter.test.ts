import { describe, it, expect } from 'vitest';
import { AgyAdapter } from '../../src/worker/agy-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('AgyAdapter & Official AGY CLI Invariants', () => {
  const processManager = new ProcessManager();

  it('constructs official AGY CLI argument flags for PLAN mode', () => {
    const adapter = new AgyAdapter('agy', 'gemini-2.5-flash', processManager);
    const planProfile = AgyAdapter.getPlanProfile();

    const args = adapter.buildInvocationArgs('Investigate codebase', 'C:\\worktree\\plan', planProfile);

    // Headless one-shot prompt
    expect(args).toContain('-p');
    expect(args).toContain('Investigate codebase');

    // Bound working directory
    expect(args).toContain('--cwd');
    expect(args).toContain('C:\\worktree\\plan');

    // Model selection
    expect(args).toContain('--model');
    expect(args).toContain('gemini-2.5-flash');

    // Terminal sandbox enabled
    expect(args).toContain('--sandbox');

    // Preventative write denials
    expect(args).toContain('--permission:fs:write=deny');
    expect(args).toContain('--permission:tools:write_file=deny');
    expect(args).toContain('--permission:tools:replace_file_content=deny');

    // Actuation and push denials
    expect(args).toContain('--permission:browser=deny');
    expect(args).toContain('--permission:network=deny');
    expect(args).toContain('--permission:git:push=deny');
    expect(args).toContain('--permission:elevation=deny');
    expect(args).toContain('--permission:ssh=deny');
  });

  it('constructs official AGY CLI argument flags for IMPLEMENT mode', () => {
    const adapter = new AgyAdapter('agy', 'gemini-2.5-flash', processManager);
    const impProfile = AgyAdapter.getImplementProfile();

    const args = adapter.buildInvocationArgs('Implement code', 'C:\\worktree\\imp', impProfile);

    expect(args).toContain('-p');
    expect(args).toContain('--cwd');
    expect(args).toContain('C:\\worktree\\imp');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-2.5-flash');
    expect(args).toContain('--sandbox');

    // File writes permitted for implementation worktree
    expect(args).not.toContain('--permission:fs:write=deny');

    // Elevation, push, and ssh strictly denied
    expect(args).toContain('--permission:git:push=deny');
    expect(args).toContain('--permission:elevation=deny');
    expect(args).toContain('--permission:ssh=deny');
  });

  it('reports AGY_CLI_MISSING clearly when executable is not present', async () => {
    const adapter = new AgyAdapter('non_existent_agy_binary_xyz_123', 'flash', processManager);
    const check = await adapter.checkAgyInstalled();

    expect(check.installed).toBe(false);
    expect(check.error).toContain('AGY_CLI_MISSING');
  });
});
