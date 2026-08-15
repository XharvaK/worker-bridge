import { describe, it, expect } from 'vitest';
import { CodexAdapter, DEFAULT_CODEX_PATH } from '../../src/worker/codex-adapter.js';

describe('Codex executable identity and .cmd rejection', () => {
  it('rejects explicit .cmd executable during invocation', async () => {
    const adapter = new CodexAdapter('C:\\tools\\codex.cmd');
    expect(adapter.getExecutablePath()).toBe('C:\\tools\\codex.cmd');

    await expect(
      adapter.invokeWorker({
        jobId: 'job-cmd-test',
        roundNumber: 1,
        modelId: 'gpt-5.6-sol',
        worktreeCwd: process.cwd(),
        executionMode: 'READ_ONLY',
        promptText: 'test prompt',
      })
    ).rejects.toThrow('Codex production executable must be a binary (.exe), not a batch wrapper.');
  });

  it('rejects explicit .bat executable during invocation', async () => {
    const adapter = new CodexAdapter('C:\\tools\\codex.bat');
    await expect(
      adapter.invokeWorker({
        jobId: 'job-bat-test',
        roundNumber: 1,
        modelId: 'gpt-5.6-sol',
        worktreeCwd: process.cwd(),
        executionMode: 'READ_ONLY',
        promptText: 'test prompt',
      })
    ).rejects.toThrow('Codex production executable must be a binary (.exe), not a batch wrapper.');
  });

  it('reports installed: false when only batch wrapper is explicitly configured', async () => {
    const adapter = new CodexAdapter('C:\\tools\\codex.cmd');
    const info = await adapter.inspectEnvironment();
    expect(info.installed).toBe(false);
    expect(info.error).toContain('Codex production executable must be a binary (.exe), not a batch wrapper.');
  });

  it('preserves configured executable and separates effective executable', () => {
    const adapter = new CodexAdapter('codex-custom.exe');
    expect(adapter.getExecutablePath()).toBe('codex-custom.exe');
    expect(adapter.effectiveExecutable).toBe('codex-custom.exe');
  });

  it('defaults to standard codex executable name', () => {
    const adapter = new CodexAdapter();
    expect(adapter.getExecutablePath()).toBe(DEFAULT_CODEX_PATH);
    expect(adapter.effectiveExecutable).toBe(DEFAULT_CODEX_PATH);
  });
});
