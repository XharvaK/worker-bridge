import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { AgyAdapter, DEFAULT_AGY_PATH } from '../../src/worker/agy-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('AGY Process CWD & Execution Flags Regression Tests', () => {
  it('explicitly sets child process CWD to the isolated worktree directory', async () => {
    const processManager = new ProcessManager();
    const runSpy = vi.spyOn(processManager, 'run').mockResolvedValue({
      exitCode: 0,
      stdout: 'Plan output',
      stderr: '',
      timedOut: false,
    });

    const adapter = new AgyAdapter(DEFAULT_AGY_PATH, 'gemini-3.7-flash-high', processManager);
    const isolatedWorktree = path.resolve('C:/Users/Xharv/Projects/.workers/test-isolation-worktree');
    const profile = AgyAdapter.getPlanProfile();

    await adapter.invokeAgent('job-cwd-test', isolatedWorktree, profile, 'Investigate repo');

    expect(runSpy).toHaveBeenCalledTimes(1);
    const callArgs = runSpy.mock.calls[0][1];

    // Child process CWD MUST be explicitly the isolated worktree
    expect(callArgs.cwd).toBe(isolatedWorktree);
    expect(callArgs.executable).toBe(DEFAULT_AGY_PATH);
    expect(callArgs.args).toContain('--add-dir');
    expect(callArgs.args).toContain(isolatedWorktree);
    expect(callArgs.args).toContain('--mode');
    expect(callArgs.args).toContain('plan');
    expect(callArgs.args).toContain('--sandbox');
    expect(callArgs.args).toContain('--effort');
    expect(callArgs.args).toContain('high');
  });
});
