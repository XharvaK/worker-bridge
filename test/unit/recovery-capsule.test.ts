import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildRecoveryCapsule,
  parseRecoveryCapsule,
  serializeRecoveryCapsule,
} from '../../src/engine/recovery-capsule.js';
import { ImplementWorker } from '../../src/worker/implement-worker.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../../src/types.js';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

class SourceWritingQuotaAdapter implements WorkerAdapter {
  readonly platformId = 'fake-worker';
  readonly supportsCrossModelSessionContinuation = false;

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return {
      platformId: this.platformId,
      displayName: 'Fake Worker',
      installed: true,
      executablePath: 'fake-worker',
    };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: 'fake-model', displayName: 'Fake Model', variants: ['high'], highestVariant: 'high' }];
  }

  async resolveReasoningProfile(): Promise<string | undefined> {
    return 'high';
  }

  async probeQuota(): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN' };
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    fs.writeFileSync(path.join(request.worktreeCwd, 'partial-source.js'), 'export const partial = true;\n');
    fs.writeFileSync(path.join(request.worktreeCwd, 'ignored-source.js'), 'export const ignored = true;\n');
    return {
      platformId: this.platformId,
      modelId: request.modelId,
      variant: request.variant,
      exitCode: 1,
      responseText: 'partial response before quota exhaustion',
      artifactsCreated: [],
      startedAt: '2026-08-14T20:00:00.000Z',
      completedAt: '2026-08-14T20:00:01.000Z',
      failureClass: 'QUOTA_EXHAUSTED',
      retryAt: '2026-08-14T21:00:00.000Z',
      rawFailureEvidence: 'quota exhausted; retry-after: 3600',
      requestPrompt: request.promptText,
      evidence: {
        stdout: 'partial response before quota exhaustion',
        stderr: 'quota exhausted; retry-after: 3600',
        partialResponse: 'partial response before quota exhaustion',
        outputTruncated: false,
        lastMeaningfulAction: 'write partial-source.js',
      },
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Recovery Capsule', () => {
  it('contains contract, worker, source state, and sanitized bounded evidence', () => {
    const capsule = buildRecoveryCapsule({
      contract: {
        jobId: 'job-capsule-001',
        round: 2,
        revision: 1,
        role: 'WORKER',
        originalGoal: 'Implement the approved change.',
        acceptedPlan: 'Edit one source file.',
        solReview: 'Preserve existing behavior.',
        ownerApproval: { approved: true, approvedBy: 'Doc' },
        baseSha: 'abcdef1234567890',
        executionConstraints: ['no push', 'run tests'],
      },
      sourceWorker: {
        targetId: 'agy_gemini_flash_37_high',
        platform: 'antigravity',
        model: 'gemini-3.7-flash-high',
        reasoning: 'high',
        sessionId: 'sess-123',
        requestPrompt: 'Implement with token=super-secret-value',
        startedAt: '2026-08-14T20:00:00.000Z',
        endedAt: '2026-08-14T20:00:01.000Z',
        failureClass: 'QUOTA_EXHAUSTED',
        retryAt: '2026-08-14T21:00:00.000Z',
      },
      capturedHistory: {
        stdout: 'partial output',
        stderr: 'Authorization: Bearer abcdefghijklmnop',
        partialResponse: 'partial output',
        outputTruncated: false,
        lastMeaningfulAction: 'edited src/index.ts',
      },
      currentState: {
        worktreePath: 'C:\\workers\\job-capsule-001',
        branch: 'worker/ashley/job-capsule-001',
        baseSha: 'abcdef1234567890',
        headSha: 'abcdef1234567890',
        gitStatus: ' M src/index.ts',
        gitDiff: 'diff --git a/src/index.ts b/src/index.ts',
        gitDiffStat: ' src/index.ts | 1 +',
        diffCheck: 'PASS',
        filesChanged: ['src/index.ts'],
        bridgeVerification: { build: 'not-run', tests: 'not-run' },
        incompleteOperations: ['quota failure during implementation'],
      },
      recoveryDirective: {
        provenComplete: ['worktree created'],
        appearsIncomplete: ['implementation verification'],
        knownFailures: ['QUOTA_EXHAUSTED'],
        remainingWork: ['verify and complete the existing implementation'],
        mustNotRepeatBlindly: ['start a clean implementation from base SHA'],
        instruction: 'CONTINUE EXISTING IMPLEMENTATION. DO NOT START OVER.',
      },
    });

    const serialized = serializeRecoveryCapsule(capsule);
    expect(capsule.contract.jobId).toBe('job-capsule-001');
    expect(capsule.sourceWorker.retryAt).toBe('2026-08-14T21:00:00.000Z');
    expect(capsule.currentState.filesChanged).toEqual(['src/index.ts']);
    expect(serialized.length).toBeLessThanOrEqual(64 * 1024);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(parseRecoveryCapsule(serialized, 'job-capsule-001')?.contract.jobId).toBe('job-capsule-001');
    expect(parseRecoveryCapsule(serialized, 'different-job')).toBeUndefined();

    const invalidSchema = JSON.stringify({ ...capsule, schemaVersion: 2 });
    expect(parseRecoveryCapsule(invalidSchema, 'job-capsule-001')).toBeUndefined();
  });

  it('keeps serialization at or below the fixed capsule limit for oversized evidence', () => {
    const capsule = buildRecoveryCapsule({
      contract: {
        jobId: 'job-capsule-large',
        round: 1,
        revision: 1,
        role: 'WORKER',
        originalGoal: 'x'.repeat(20000),
        acceptedPlan: 'x'.repeat(20000),
        solReview: 'x'.repeat(20000),
        baseSha: 'abcdef1234567890',
        executionConstraints: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
      },
      sourceWorker: {
        platform: 'fake',
        model: 'fake-model',
        requestPrompt: 'x'.repeat(20000),
      },
      capturedHistory: {
        stdout: 'x'.repeat(20000),
        stderr: 'x'.repeat(20000),
        partialResponse: 'x'.repeat(20000),
        outputTruncated: true,
      },
      currentState: {
        worktreePath: 'C:\\workers\\large',
        baseSha: 'abcdef1234567890',
        gitStatus: 'x'.repeat(20000),
        gitDiff: 'x'.repeat(20000),
        gitDiffStat: 'x'.repeat(20000),
        diffCheck: 'x'.repeat(20000),
        filesChanged: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        bridgeVerification: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`check-${index}`, 'x'.repeat(2000)])),
        incompleteOperations: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
      },
      recoveryDirective: {
        provenComplete: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        appearsIncomplete: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        knownFailures: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        remainingWork: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        mustNotRepeatBlindly: Array.from({ length: 64 }, () => 'x'.repeat(2000)),
        instruction: 'x'.repeat(20000),
      },
    });

    expect(Buffer.byteLength(serializeRecoveryCapsule(capsule), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('preserves an implementation worktree when quota fails after source effects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-worktree-'));
    tempRoots.push(root);
    const repo = path.join(root, 'repo');
    const workers = path.join(root, 'workers');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(workers, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'RecoveryTest'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'recovery@test.local'], { cwd: repo, windowsHide: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Recovery\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored-source.js\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo, windowsHide: true });
    const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true });

    const worker = new ImplementWorker(new WorktreeManager(workers), new SourceWritingQuotaAdapter());
    const result = await worker.execute(
      'job-source-effect-001',
      'recovery-project',
      { path: repo, allowed: true, defaultBranch: 'master', allowPushWorkerBranch: false },
      sha.trim(),
      'Implement the approved change.',
      'Edit one source file.',
      'Approved.',
      false,
      'origin',
      30,
      new SourceWritingQuotaAdapter(),
      'fake-model',
      'high'
    );

    expect(result.failureClass).toBe('QUOTA_EXHAUSTED');
    expect(result.sourceEffectsPresent).toBe(true);
    expect(result.worktreePath).toBeDefined();
    expect(fs.existsSync(result.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(result.worktreePath!, 'partial-source.js'))).toBe(true);
    expect(fs.existsSync(path.join(result.worktreePath!, 'ignored-source.js'))).toBe(true);
    expect(result.filesChanged.some((file) => file.includes('ignored-source.js'))).toBe(true);

    await new WorktreeManager(workers).forceCleanupWorktree(repo, result.worktreePath!);
  });
});
