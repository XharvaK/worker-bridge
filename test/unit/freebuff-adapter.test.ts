import { describe, it, expect, vi } from 'vitest';
import { FreebuffAdapter } from '../../src/worker/freebuff-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';
import { WorkerAdapterError } from '../../src/worker/worker-adapter.js';

describe('FreebuffAdapter (freebuff)', () => {
  it('has platformId freebuff and supportsCrossModelSessionContinuation false', () => {
    const adapter = new FreebuffAdapter('freebuff');
    expect(adapter.platformId).toBe('freebuff');
    expect(adapter.supportsCrossModelSessionContinuation).toBe(false);
  });

  it('inspects environment and executes --version directly', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    const env = await adapter.inspectEnvironment();
    expect(env.platformId).toBe('freebuff');
    expect(env.displayName).toBe('Freebuff');
    expect(typeof env.installed).toBe('boolean');
    if (!env.installed) {
      expect(env.version).toBeUndefined();
    }
  });

  it('returns empty array for discoverModels (provider-managed catalog)', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    const models = await adapter.discoverModels();
    expect(models).toEqual([]);
  });

  it('returns undefined for resolveReasoningProfile (provider-managed reasoning)', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    const profile = await adapter.resolveReasoningProfile('provider-managed');
    expect(profile).toBeUndefined();
  });

  it('probeQuota qualifies as ERROR with AUTOMATION_SEAM_UNAVAILABLE and a bounded re-qualification horizon', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    const quota = await adapter.probeQuota();
    expect(quota.state).toBe('ERROR');
    expect(quota.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
    expect(quota.details).toContain('no supported non-interactive task-delivery seam');
    // The bounded horizon converts the failure record into a COOLDOWN so the
    // provider is re-qualified later instead of being permanently suppressed.
    expect(quota.resetsAt).toBeDefined();
    expect(Date.parse(quota.resetsAt!) - Date.now()).toBeGreaterThan(0);
  });

  it('validateExecutionContext rejects READ_ONLY mode with PERMISSION_BLOCKED', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    await expect(
      adapter.validateExecutionContext({
        jobId: 'job-fb-01',
        roundNumber: 1,
        executionMode: 'READ_ONLY',
        worktreeCwd: 'C:\\Projects\\repo\\.workers\\wt-01',
        promptText: 'Analyze code',
        modelId: 'provider-managed',
      })
    ).rejects.toThrowError(WorkerAdapterError);

    try {
      await adapter.validateExecutionContext({
        jobId: 'job-fb-01',
        roundNumber: 1,
        executionMode: 'READ_ONLY',
        worktreeCwd: 'C:\\Projects\\repo\\.workers\\wt-01',
        promptText: 'Analyze code',
        modelId: 'provider-managed',
      });
    } catch (err: any) {
      expect(err.failureClass).toBe('PERMISSION_BLOCKED');
    }
  });

  it('validateExecutionContext rejects WORKTREE_WRITE mode with AUTOMATION_SEAM_UNAVAILABLE', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    try {
      await adapter.validateExecutionContext({
        jobId: 'job-fb-02',
        roundNumber: 1,
        executionMode: 'WORKTREE_WRITE',
        worktreeCwd: 'C:\\Projects\\repo\\.workers\\wt-02',
        promptText: 'Fix bug',
        modelId: 'provider-managed',
      });
      expect.unreachable('Should have thrown WorkerAdapterError');
    } catch (err: any) {
      expect(err.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
    }
  });

  it('invokeWorker fails closed with AUTOMATION_SEAM_UNAVAILABLE without launching interactive TUI', async () => {
    const adapter = new FreebuffAdapter('freebuff');
    try {
      await adapter.invokeWorker({
        jobId: 'job-fb-03',
        roundNumber: 1,
        executionMode: 'WORKTREE_WRITE',
        worktreeCwd: 'C:\\Projects\\repo\\.workers\\wt-03',
        promptText: 'Implement feature',
        modelId: 'provider-managed',
      });
      expect.unreachable('Should have thrown WorkerAdapterError');
    } catch (err: any) {
      expect(err.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
      expect(err.message).toContain('AUTOMATION_SEAM_UNAVAILABLE');
    }
  });

  it('cancel delegates to processManager', async () => {
    const mockProcessManager = new ProcessManager();
    vi.spyOn(mockProcessManager, 'cancelJob').mockResolvedValueOnce(true);

    const adapter = new FreebuffAdapter('freebuff', mockProcessManager);
    const result = await adapter.cancel('job-fb-04');
    expect(result).toBe(true);
    expect(mockProcessManager.cancelJob).toHaveBeenCalledWith('job-fb-04');
  });
});
