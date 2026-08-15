import { describe, it, expect, vi } from 'vitest';
import { CursorAdapter } from '../../src/worker/cursor-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('CursorAdapter (cursor-cli)', () => {
  it('has platformId cursor-cli and default model cursor-grok-4.6-xhigh', () => {
    const adapter = new CursorAdapter('cursor-agent', 'cursor-grok-4.6-xhigh');
    expect(adapter.platformId).toBe('cursor-cli');
    expect(adapter.getModel()).toBe('cursor-grok-4.6-xhigh');
  });

  it('resolves direct native executable without cmd.exe or shell=true', () => {
    const adapter = new CursorAdapter('cursor-agent', 'cursor-grok-4.6-xhigh');
    const resolution = adapter.resolveDirectExecutable();
    if (resolution) {
      expect(resolution.nativeExecutable).toMatch(/\.exe$/i);
      expect(resolution.isCmdWrapper).toBe(false);
      expect(resolution.cliScript).toMatch(/\.js$/i);
    }
  });

  it('discovers exact authenticated grok models (cursor-grok-4.6-xhigh and cursor-grok-4.6-medium)', async () => {
    const adapter = new CursorAdapter('cursor-agent', 'cursor-grok-4.6-xhigh');
    const models = await adapter.discoverModels();
    expect(models.length).toBeGreaterThanOrEqual(2);

    const xhigh = models.find((m) => m.id === 'cursor-grok-4.6-xhigh');
    expect(xhigh).toBeDefined();
    expect(xhigh?.id).toBe('cursor-grok-4.6-xhigh');
    expect(xhigh?.selectability).toBe('SELECTABLE');

    const medium = models.find((m) => m.id === 'cursor-grok-4.6-medium');
    expect(medium).toBeDefined();
    expect(medium?.id).toBe('cursor-grok-4.6-medium');
    expect(medium?.selectability).toBe('SELECTABLE');
  });

  it('builds invocation arguments for READ_ONLY using mechanical --mode ask without --force', () => {
    const adapter = new CursorAdapter('cursor-agent', 'cursor-grok-4.6-xhigh');

    // READ_ONLY must use mechanical ask mode
    const readOnlyArgs = adapter.buildInvocationArgs(
      'Analyze codebase',
      'C:\\Projects\\repo\\.workers\\worktree',
      'READ_ONLY',
      'cursor-grok-4.6-xhigh'
    );
    expect(readOnlyArgs).toContain('-p');
    expect(readOnlyArgs).toContain('--mode');
    expect(readOnlyArgs).toContain('ask');
    expect(readOnlyArgs).toContain('--workspace');
    expect(readOnlyArgs).toContain('C:\\Projects\\repo\\.workers\\worktree');
    expect(readOnlyArgs).toContain('--model');
    expect(readOnlyArgs).toContain('cursor-grok-4.6-xhigh');
    expect(readOnlyArgs).not.toContain('--force');
    expect(readOnlyArgs).not.toContain('--yolo');
    expect(readOnlyArgs).toContain('Analyze codebase');
  });

  it('invokes worker through process manager and returns structured result', async () => {
    const mockProcessManager = new ProcessManager();
    vi.spyOn(mockProcessManager, 'run').mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Investigation complete: no issues found.',
      stderr: '',
      timedOut: false,
      pid: 1234,
      outputTruncated: false,
    });

    const adapter = new CursorAdapter('cursor-agent', 'cursor-grok-4.6-xhigh', mockProcessManager);
    vi.spyOn(adapter, 'inspectEnvironment').mockResolvedValueOnce({
      platformId: 'cursor-cli',
      displayName: 'Cursor CLI',
      installed: true,
      version: '2026.08.11-e8db854',
    });

    const result = await adapter.invokeWorker({
      jobId: 'job-test-001',
      roundNumber: 1,
      executionMode: 'READ_ONLY',
      worktreeCwd: 'C:\\Projects\\repo\\.workers\\wt-001',
      promptText: 'Investigate architecture',
      modelId: 'cursor-grok-4.6-xhigh',
    });

    expect(result.platformId).toBe('cursor-cli');
    expect(result.modelId).toBe('cursor-grok-4.6-xhigh');
    expect(result.exitCode).toBe(0);
    expect(result.responseText).toContain('Investigation complete');
    expect(mockProcessManager.run).toHaveBeenCalledWith(
      'job-test-001',
      expect.objectContaining({
        cwd: 'C:\\Projects\\repo\\.workers\\wt-001',
        env: expect.objectContaining({
          WORKER_BRIDGE_PARENT_JOB_ID: 'job-test-001',
          WORKER_BRIDGE_EXECUTION_DEPTH: '1',
          WORKER_BRIDGE_EXECUTION_CONTEXT: 'worker-child',
        }),
      })
    );
  });
});
