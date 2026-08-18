import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../../src/config.js';
import {
  ReadOnlyExecutionKernel,
  ReadOnlyExecutionRequest,
  ReadOnlySelectionBlocked,
} from '../../src/engine/read-only-kernel.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { ProcessManager } from '../../src/engine/process-manager.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../../src/types.js';

const execFileAsync = promisify(execFile);

type FakeMode = 'success' | 'quota' | 'mutate';

class KernelTestAdapter implements WorkerAdapter {
  readonly supportsCrossModelSessionContinuation = false;
  readonly calls: WorkerInvocationRequest[] = [];

  constructor(
    readonly platformId: string,
    private readonly mode: FakeMode
  ) {}

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return {
      platformId: this.platformId,
      displayName: this.platformId,
      installed: true,
      executablePath: `mock-${this.platformId}`,
    };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: `${this.platformId}-model`, displayName: `${this.platformId} model`, variants: ['high'], highestVariant: 'high' }];
  }

  async resolveReasoningProfile(): Promise<string | undefined> {
    return 'high';
  }

  async probeQuota(): Promise<QuotaProbeResult> {
    return { state: 'AVAILABLE' };
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    this.calls.push(request);
    const now = new Date().toISOString();
    if (this.mode === 'mutate') {
      fs.writeFileSync(path.join(request.worktreeCwd, 'touched.js'), 'export const touched = true;\n');
      return {
        platformId: this.platformId,
        modelId: request.modelId,
        variant: request.variant,
        exitCode: 0,
        responseText: 'done',
        artifactsCreated: [],
        startedAt: now,
        completedAt: now,
      };
    }
    if (this.mode === 'quota') {
      return {
        platformId: this.platformId,
        modelId: request.modelId,
        variant: request.variant,
        exitCode: 1,
        responseText: 'quota exhausted',
        artifactsCreated: [],
        startedAt: now,
        completedAt: now,
        failureClass: 'QUOTA_EXHAUSTED',
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
        rawFailureEvidence: 'retry-after: 3600',
        evidence: {
          stdout: 'partial response',
          stderr: 'quota exhausted; retry-after: 3600',
          partialResponse: 'partial response',
          outputTruncated: false,
          sessionId: `session-${this.platformId}`,
        },
      };
    }
    return {
      platformId: this.platformId,
      modelId: request.modelId,
      variant: request.variant,
      exitCode: 0,
      responseText: `plan from ${this.platformId}`,
      artifactsCreated: [],
      startedAt: now,
      completedAt: now,
      platformSessionId: `session-${this.platformId}`,
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

describe('ReadOnlyExecutionKernel', () => {
  let root: string;
  let repo: string;
  let workers: string;
  let baseSha: string;
  let availabilityPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bridge-kernel-'));
    repo = path.join(root, 'repo');
    workers = path.join(root, 'workers');
    availabilityPath = path.join(root, 'availability.json');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(workers, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Kernel Test'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'kernel@test.local'], { cwd: repo, windowsHide: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Kernel test\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo, windowsHide: true });
    const sha = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true });
    baseSha = sha.stdout.trim();
  });

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeConfig(): ConfigManager {
    return new ConfigManager({
      mailboxRepoPath: path.join(root, 'mailbox'),
      workerRootDir: workers,
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {
        kernel: { path: repo, allowed: true, defaultBranch: 'master', allowPushWorkerBranch: false },
      },
      selectionPolicy: {
        targets: {
          target_a: {
            targetId: 'target_a',
            platformId: 'mock-a',
            modelId: 'mock-a-model',
            displayName: 'Mock A',
            reasoning: { strategy: 'highest-supported' },
          },
          target_b: {
            targetId: 'target_b',
            platformId: 'mock-b',
            modelId: 'mock-b-model',
            displayName: 'Mock B',
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {
          PLANNER: ['target_a', 'target_b'],
          INVESTIGATOR: ['target_a', 'target_b'],
          WORKER: ['target_a', 'target_b'],
          REVIEWER: ['target_a', 'target_b'],
        },
        allowFallbackByDefault: true,
        maxFallbackAttempts: 2,
      },
    });
  }

  function makeKernel(a: KernelTestAdapter, b: KernelTestAdapter): { kernel: ReadOnlyExecutionKernel; availability: TargetAvailabilityLedger } {
    const registry = new AdapterRegistry();
    registry.register(a);
    registry.register(b);
    const availability = new TargetAvailabilityLedger(availabilityPath);
    const kernel = new ReadOnlyExecutionKernel(makeConfig(), {
      adapterRegistry: registry,
      availability,
      processManager: new ProcessManager(),
      worktreeManager: new WorktreeManager(workers),
    });
    return { kernel, availability };
  }

  function request(overrides?: Partial<ReadOnlyExecutionRequest>): ReadOnlyExecutionRequest {
    return {
      jobId: 'job-kernel-test',
      projectId: 'kernel',
      projectPath: repo,
      intent: 'investigate',
      goal: 'Inspect the repository and describe the entry point.',
      baseSha,
      ...overrides,
    };
  }

  it('derives the INVESTIGATOR role from investigate intent and executes through the ranked target', async () => {
    const a = new KernelTestAdapter('mock-a', 'success');
    const b = new KernelTestAdapter('mock-b', 'success');
    const { kernel, availability } = makeKernel(a, b);

    const resolved = await kernel.resolve(request());
    expect(resolved.role).toBe('INVESTIGATOR');
    expect(resolved.selection.targetId).toBe('target_a');
    expect(resolved.baseSha).toBe(baseSha);

    const outcome = await kernel.execute(request(), resolved);
    expect(outcome.terminalState).toBe('WORKER_RETURNED');
    expect(outcome.selectedTarget.targetId).toBe('target_a');
    expect(outcome.planResult.planText).toContain('plan from mock-a');
    expect(outcome.verification).toContain('READ_ONLY verified');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(availability.get('target_a')?.state).toBe('AVAILABLE');
  });

  it('honors an explicit REVIEWER role', async () => {
    const a = new KernelTestAdapter('mock-a', 'success');
    const { kernel } = makeKernel(a, new KernelTestAdapter('mock-b', 'success'));

    const resolved = await kernel.resolve(request({ role: 'REVIEWER' }));
    expect(resolved.role).toBe('REVIEWER');
  });

  it('falls back across eligible targets after a quota failure and records the cooldown', async () => {
    const a = new KernelTestAdapter('mock-a', 'quota');
    const b = new KernelTestAdapter('mock-b', 'success');
    const { kernel, availability } = makeKernel(a, b);

    const resolved = await kernel.resolve(request());
    const outcome = await kernel.execute(request(), resolved);

    expect(outcome.terminalState).toBe('WORKER_RETURNED');
    expect(outcome.selectedTarget.targetId).toBe('target_b');
    expect(outcome.attempts).toBe(1);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(availability.get('target_a')?.state).toBe('COOLDOWN');
    expect(availability.get('target_b')?.state).toBe('AVAILABLE');
  });

  it('does not fall back from an explicit target selection', async () => {
    const a = new KernelTestAdapter('mock-a', 'quota');
    const b = new KernelTestAdapter('mock-b', 'success');
    const { kernel, availability } = makeKernel(a, b);

    const resolved = await kernel.resolve(request({ workerSelection: { targetId: 'target_a' } }));
    const outcome = await kernel.execute(request({ workerSelection: { targetId: 'target_a' } }), resolved);

    expect(outcome.terminalState).toBe('FAILED');
    expect(outcome.selectedTarget.targetId).toBe('target_a');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(availability.get('target_a')?.state).toBe('COOLDOWN');
  });

  it('fails closed with READ_ONLY violation evidence when the worker mutates source files', async () => {
    const a = new KernelTestAdapter('mock-a', 'mutate');
    const { kernel } = makeKernel(a, new KernelTestAdapter('mock-b', 'success'));

    const resolved = await kernel.resolve(request());
    const outcome = await kernel.execute(request(), resolved);

    expect(outcome.terminalState).toBe('FAILED');
    expect(outcome.planResult.clean).toBe(false);
    expect(outcome.planResult.mutatedFiles.some((f) => f.includes('touched.js'))).toBe(true);
    expect(outcome.verification).toContain('READ_ONLY violation');
  });

  it('fails closed with a pre-invocation capsule when the project is missing', async () => {
    const a = new KernelTestAdapter('mock-a', 'success');
    const { kernel } = makeKernel(a, new KernelTestAdapter('mock-b', 'success'));

    const promise = kernel.resolve(request({ projectPath: path.join(root, 'missing') }));
    await expect(promise).rejects.toBeInstanceOf(ReadOnlySelectionBlocked);
    try {
      await promise;
    } catch (err) {
      const blocked = err as ReadOnlySelectionBlocked;
      expect(blocked.failureClass).toBe('PROCESS_FAILED');
      expect(blocked.message).toContain('PROJECT_NOT_FOUND');
      expect(blocked.capsule?.contract.executionMode).toBe('READ_ONLY');
      expect(blocked.capsule?.contract.jobId).toBe('job-kernel-test');
    }
    expect(a.calls).toHaveLength(0);
  });

  it('fails closed for CONTINUE without an exact persisted session id', async () => {
    const a = new KernelTestAdapter('mock-a', 'success');
    const { kernel } = makeKernel(a, new KernelTestAdapter('mock-b', 'success'));

    const promise = kernel.resolve(request({ sessionPolicy: 'CONTINUE' }));
    await expect(promise).rejects.toBeInstanceOf(ReadOnlySelectionBlocked);
    try {
      await promise;
    } catch (err) {
      const blocked = err as ReadOnlySelectionBlocked;
      expect(blocked.failureClass).toBe('SESSION_ID_UNAVAILABLE');
      expect(blocked.capsule?.sourceWorker.failureClass).toBe('SESSION_ID_UNAVAILABLE');
    }
    expect(a.calls).toHaveLength(0);
  });

  it('keeps the persisted target/model under CONTINUE but starts a fresh session when the read-only worktree cannot match', async () => {
    const a = new KernelTestAdapter('mock-a', 'success');
    const { kernel } = makeKernel(a, new KernelTestAdapter('mock-b', 'success'));

    const req = request({
      sessionPolicy: 'CONTINUE',
      previousSession: {
        targetId: 'target_a',
        platform: 'mock-a',
        model: 'mock-a-model',
        reasoning: 'high',
        sessionId: 'session-mock-a',
        worktreeCwd: path.join(workers, 'plan-kernel-job-kernel-test'),
        executionMode: 'READ_ONLY',
      },
    });
    const resolved = await kernel.resolve(req);
    expect(resolved.selection.targetId).toBe('target_a');
    expect(resolved.sessionIdToUse).toBeUndefined();

    const outcome = await kernel.execute(req, resolved);
    expect(outcome.terminalState).toBe('WORKER_RETURNED');
  });
});