import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager } from '../../src/service/job-manager.js';

describe('JobManager', () => {
  let rootDir: string;
  let projectDir: string;
  let outsideDir: string;
  let manager: JobManager;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mgr-root-'));
    projectDir = path.join(rootDir, 'my-project');
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mgr-outside-'));
    fs.mkdirSync(projectDir, { recursive: true });

    const storagePath = path.join(rootDir, 'service-ledger.json');
    manager = new JobManager({
      trustedRoots: [rootDir],
      storagePath,
    });
  });

  afterEach(() => {
    if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true });
    if (fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('creates READ_ONLY job in PENDING state without approval challenge', () => {
    const result = manager.createJob({
      clientRequestId: 'req-001',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Write architecture proposal',
    });

    expect(result.jobId).toMatch(/^job-/);
    expect(result.state).toBe('PENDING');
    expect(result.executionMode).toBe('READ_ONLY');
    expect(result.requiresOwnerApproval).toBe(false);
    expect(result.approvalChallenge).toBeUndefined();
  });

  it('fails WORKTREE_WRITE closed with OWNER_AUTHORITY_UNAVAILABLE in MCP v1', () => {
    expect(() =>
      manager.createJob({
        clientRequestId: 'req-write-001',
        projectPath: projectDir,
        intent: 'implement',
        executionMode: 'WORKTREE_WRITE',
        goal: 'Implement bug fix',
      })
    ).toThrow('OWNER_AUTHORITY_UNAVAILABLE');
  });

  it('persists completed job state and idempotency keys to disk across manager restart', () => {
    const storagePath = path.join(rootDir, 'service-ledger.json');
    const firstJob = manager.createJob({
      clientRequestId: 'req-persist-001',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Persistent job test',
    });

    manager.updateJobResult(firstJob.jobId, {
      state: 'WORKER_RETURNED',
      resultText: 'finished plan result',
    });

    // Simulate process restart by creating a new JobManager with the same storagePath
    const restartedManager = new JobManager({
      trustedRoots: [rootDir],
      storagePath,
    });

    const retrieved = restartedManager.getJob(firstJob.jobId);
    expect(retrieved.jobId).toBe(firstJob.jobId);
    expect(retrieved.state).toBe('WORKER_RETURNED');

    // Idempotent start_job on restarted manager returns the persisted jobId
    const duplicate = restartedManager.createJob({
      clientRequestId: 'req-persist-001',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Persistent job test',
    });
    expect(duplicate.jobId).toBe(firstJob.jobId);
    expect(duplicate.state).toBe('WORKER_RETURNED');
  });

  it('reconciles orphaned in-flight nonterminal jobs on service startup', () => {
    const storagePath = path.join(rootDir, 'service-ledger.json');

    // Case 1: In-flight read-only job
    const readJob = manager.createJob({
      clientRequestId: 'req-inflight-read',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'In-flight read test',
    });
    manager.updateJobResult(readJob.jobId, { state: 'WORKER_RUNNING' });

    // Case 2: In-flight write job with source effects (simulated in ledger)
    const writeJobRecord = {
      jobId: 'job-write-effects-001',
      clientRequestId: 'req-inflight-write',
      payloadHash: 'dummyhash',
      projectPath: projectDir,
      intent: 'implement' as const,
      executionMode: 'WORKTREE_WRITE' as const,
      goal: 'Write job',
      state: 'WORKER_RUNNING' as const,
      requiresOwnerApproval: false,
      sourceEffectsPresent: true,
      createdAt: new Date().toISOString(),
    };
    const rawData = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    rawData.jobs.push(writeJobRecord);
    fs.writeFileSync(storagePath, JSON.stringify(rawData, null, 2), 'utf8');

    // Restart daemon
    const restarted = new JobManager({
      trustedRoots: [rootDir],
      storagePath,
    });

    // Verify read job reconciled to INTERRUPTED
    const readReconciled = restarted.getJob(readJob.jobId);
    expect(readReconciled.state).toBe('INTERRUPTED');
    expect(readReconciled.error).toContain('INTERRUPTED');

    // Verify write job with source effects reconciled to INTERRUPTED_WITH_SOURCE_STATE
    const writeReconciled = restarted.getJob('job-write-effects-001');
    expect(writeReconciled.state).toBe('INTERRUPTED_WITH_SOURCE_STATE');
    expect(writeReconciled.recoveryStatus).toBe('RECOVERY_REQUIRED');
  });

  it('replays identical job on duplicate clientRequestId (idempotent)', () => {
    const first = manager.createJob({
      clientRequestId: 'req-idem',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Perform analysis',
    });

    const second = manager.createJob({
      clientRequestId: 'req-idem',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Perform analysis',
    });

    expect(second.jobId).toBe(first.jobId);
    expect(second.state).toBe(first.state);
  });

  it('rejects duplicate clientRequestId with different payload (IDEMPOTENCY_CONFLICT)', () => {
    manager.createJob({
      clientRequestId: 'req-conflict',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'First goal',
    });

    expect(() =>
      manager.createJob({
        clientRequestId: 'req-conflict',
        projectPath: projectDir,
        intent: 'plan',
        executionMode: 'READ_ONLY',
        goal: 'Different second goal',
      })
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('rejects project paths outside the trusted root', () => {
    expect(() =>
      manager.createJob({
        clientRequestId: 'req-escape',
        projectPath: outsideDir,
        intent: 'plan',
        executionMode: 'READ_ONLY',
        goal: 'Escape test',
      })
    ).toThrow('PATH_ESCAPE');
  });

  it('paginates large results cleanly with bounded page sizes', () => {
    const job = manager.createJob({
      clientRequestId: 'req-paginate',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Pagination test',
    });

    const fullText = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    manager.updateJobResult(job.jobId, {
      resultText: fullText,
      state: 'WORKER_RETURNED',
    });

    const page1 = manager.getResult(job.jobId, 0, 14);
    expect(page1.resultText).toBe('line 1\nline 2\n');
    expect(page1.offset).toBe(0);
    expect(page1.nextOffset).toBe(14);
    expect(page1.hasMore).toBe(true);

    const page2 = manager.getResult(job.jobId, 14, 14);
    expect(page2.resultText).toBe('line 3\nline 4\n');
    expect(page2.offset).toBe(14);
    expect(page2.nextOffset).toBe(28);
    expect(page2.hasMore).toBe(true);

    const page3 = manager.getResult(job.jobId, 28, 14);
    expect(page3.resultText).toBe('line 5\n');
    expect(page3.offset).toBe(28);
    expect(page3.nextOffset).toBe(35);
    expect(page3.hasMore).toBe(false);
  });

  it('cancels running jobs and returns previous and new states', () => {
    const job = manager.createJob({
      clientRequestId: 'req-cancel',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Cancel test',
    });

    const cancelled = manager.cancelJob(job.jobId);
    expect(cancelled.previousState).toBe('PENDING');
    expect(cancelled.newState).toBe('CANCELLED');
    expect(cancelled.sourceEffectsPresent).toBe(false);
    expect(cancelled.recoveryRequired).toBe(false);

    // Cancelling again is idempotent
    const reCancelled = manager.cancelJob(job.jobId);
    expect(reCancelled.newState).toBe('CANCELLED');
  });

  it('preserves source-state evidence on cancellation when source effects are present', () => {
    const job = manager.createJob({
      clientRequestId: 'req-cancel-effects',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Source effects cancel test',
    });

    // Mark that worker has made source mutations before cancel arrived
    manager.updateJobResult(job.jobId, {
      state: 'WORKER_RUNNING',
      sourceEffectsPresent: true,
    });

    const cancelled = manager.cancelJob(job.jobId);
    expect(cancelled.previousState).toBe('WORKER_RUNNING');
    expect(cancelled.newState).toBe('INTERRUPTED_WITH_SOURCE_STATE');
    expect(cancelled.sourceEffectsPresent).toBe(true);
    expect(cancelled.recoveryRequired).toBe(true);
  });
});
