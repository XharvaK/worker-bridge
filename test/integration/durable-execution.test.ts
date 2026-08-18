import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../../src/config.js';
import {
  ProcessManager,
  ProcessRunOptions,
  ProcessRunResult,
  TerminationOutcome,
} from '../../src/engine/process-manager.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { DurableService } from '../../src/service/durable-service.js';
import { getServicePipePath } from '../../src/service/ipc-protocol.js';
import { JobManager } from '../../src/service/job-manager.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  GetJobResult,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../../src/types.js';

const execFileAsync = promisify(execFile);

type FakeMode = 'success' | 'quota' | 'sleep' | 'mutate';

class DurableTestAdapter implements WorkerAdapter {
  readonly supportsCrossModelSessionContinuation = false;
  readonly calls: WorkerInvocationRequest[] = [];

  constructor(
    readonly platformId: string,
    private readonly mode: FakeMode,
    private readonly processManager: ProcessManager
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
    if (this.mode === 'sleep') {
      const runResult = await this.processManager.run(request.jobId, {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 45000)'],
        cwd: request.worktreeCwd,
        timeoutSeconds: 60,
      });
      return {
        platformId: this.platformId,
        modelId: request.modelId,
        variant: request.variant,
        exitCode: runResult.exitCode,
        responseText: runResult.exitCode === 0 ? 'slow worker finished' : `worker terminated (exit ${runResult.exitCode})`,
        artifactsCreated: [],
        startedAt: now,
        completedAt: new Date().toISOString(),
      };
    }
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

class GatedProcessManager extends ProcessManager {
  readonly runCalls: Array<{ jobId: string }> = [];
  readonly terminateCalls: string[] = [];
  terminationOutcome: TerminationOutcome = 'TERMINATED';
  terminationOutcomes: TerminationOutcome[] = [];
  private waiters: Array<() => void> = [];
  private holdRun = true;

  override async run(jobId: string, options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.runCalls.push({ jobId });
    if (this.holdRun) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return { exitCode: 0, stdout: 'gated worker finished', stderr: '', timedOut: false, pid: null, outputTruncated: false };
  }

  override async terminateJob(jobId: string): Promise<TerminationOutcome> {
    this.terminateCalls.push(jobId);
    if (this.terminationOutcomes.length > 0) return this.terminationOutcomes.shift()!;
    return this.terminationOutcome;
  }

  releaseAll(): void {
    this.holdRun = false;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

const TERMINAL_STATES = new Set(['WORKER_RETURNED', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED', 'INTERRUPTED_WITH_SOURCE_STATE']);

async function waitForTerminal(service: DurableService, jobId: string, timeoutMs = 90_000): Promise<GetJobResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob({ jobId: jobId });
    if (TERMINAL_STATES.has(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for terminal state; last state: ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForState(service: DurableService, jobId: string, state: string, timeoutMs = 90_000): Promise<GetJobResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob({ jobId: jobId });
    if (job.state === state) return job;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for state ${state}; last state: ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Durable IPC execution', () => {
  let root: string;
  let repo: string;
  let workers: string;
  let storagePath: string;
  let availabilityPath: string;
  let baseSha: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bridge-durable-'));
    repo = path.join(root, 'repo');
    workers = path.join(root, 'workers');
    storagePath = path.join(root, 'ipc-jobs.json');
    availabilityPath = path.join(root, 'availability.json');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(workers, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Durable Test'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'durable@test.local'], { cwd: repo, windowsHide: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Durable test\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo, windowsHide: true });
    const sha = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true });
    baseSha = sha.stdout.trim();
  });

  afterEach(async () => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeConfig(): ConfigManager {
    return new ConfigManager({
      mailboxRepoPath: path.join(root, 'mailbox'),
      workerRootDir: workers,
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {
        durable: { path: repo, allowed: true, defaultBranch: 'master', allowPushWorkerBranch: false },
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
        allowFallbackByDefault: false,
        maxFallbackAttempts: 2,
      },
    });
  }

  function makeService(
    adapterFactories: (pm: ProcessManager) => DurableTestAdapter[],
    opts: { processManager?: ProcessManager } = {}
  ): { service: DurableService; adapters: DurableTestAdapter[] } {
    const registry = new AdapterRegistry();
    const jobManager = new JobManager({ trustedRoots: [root], storagePath });
    const service = new DurableService({
      pipePath: getServicePipePath(`test-${Math.random().toString(36).slice(2)}`),
      configManager: makeConfig(),
      availabilityLedger: new TargetAvailabilityLedger(availabilityPath),
      jobManager,
      adapterRegistry: registry,
      trustedRoots: [root],
      processManager: opts.processManager,
    });
    const adapters = adapterFactories(service.getProcessManager());
    for (const adapter of adapters) registry.register(adapter);
    return { service, adapters };
  }

  function startParams(clientRequestId: string, goal = 'Inspect the repository and identify the main entry point.'): Record<string, unknown> {
    return {
      clientRequestId,
      projectPath: repo,
      intent: 'investigate',
      executionMode: 'READ_ONLY',
      goal,
      baseSha,
    };
  }

  it('executes a READ_ONLY job: PENDING → WORKER_RUNNING → WORKER_RETURNED with the selected target and persisted result', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'success', pm)]);
    const a = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-1') as never);
      expect(start.state).toBe('PENDING');

      const running = await waitForState(service, start.jobId, 'WORKER_RUNNING');
      expect(running.target).toBe('target_a');
      expect(running.platform).toBe('mock-a');
      expect(running.model).toBe('mock-a-model');

      const done = await waitForTerminal(service, start.jobId);
      expect(done.state).toBe('WORKER_RETURNED');
      expect(done.target).toBe('target_a');
      expect(done.verification).toContain('READ_ONLY verified');
      expect(done.changedFiles).toEqual([]);
      expect(done.completedAt).toBeTruthy();

      const result = service.getResult({ jobId: start.jobId });
      expect(result.state).toBe('WORKER_RETURNED');
      expect(result.resultText).toContain('plan from mock-a');
      expect(result.hasMore).toBe(false);
      expect(a.calls).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it('invokes a worker only once for a duplicate clientRequestId', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'success', pm)]);
    const a = adapters[0];
    await service.start();
    try {
      const first = service.startJob(startParams('durable-dup') as never);
      const second = service.startJob(startParams('durable-dup') as never);
      expect(second.jobId).toBe(first.jobId);
      await waitForTerminal(service, first.jobId);
      expect(a.calls).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it('cancels a queued job before execution: CANCELLED with no invocation', { timeout: 120000 }, async () => {
    const gated = new GatedProcessManager();
    const { service, adapters } = makeService(
      (pm) => [
        new DurableTestAdapter('mock-a', 'sleep', pm),
        new DurableTestAdapter('mock-b', 'success', pm),
      ],
      { processManager: gated }
    );
    const slowA = adapters[0];
    const b = adapters[1];
    await service.start();
    try {
      const first = service.startJob(startParams('durable-queue-1') as never);
      await waitForState(service, first.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const second = service.startJob(startParams('durable-queue-2') as never);
      expect(second.state).toBe('PENDING');

      const cancel = await service.cancelJob({ jobId: second.jobId });
      expect(cancel.previousState).toBe('PENDING');
      expect(cancel.newState).toBe('CANCELLED');

      gated.releaseAll();
      const done = await waitForTerminal(service, first.jobId);
      expect(done.state).toBe('WORKER_RETURNED');
      const secondJob = service.getJob({ jobId: second.jobId });
      expect(secondJob.state).toBe('CANCELLED');
      expect(b.calls).toHaveLength(0);
      expect(gated.terminateCalls).toHaveLength(0);
    } finally {
      await service.stop();
    }
  });

  it('cancels an in-flight job: worker process terminated and CANCELLED preserved', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)]);
    const slowA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-cancel-flight') as never);
      await waitForState(service, start.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before cancel.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(slowA.calls).toHaveLength(1);

      const cancel = await service.cancelJob({ jobId: start.jobId });
      expect(cancel.previousState).toBe('WORKER_RUNNING');
      expect(cancel.newState).toBe('CANCELLED');

      const done = service.getJob({ jobId: start.jobId });
      expect(done.state).toBe('CANCELLED');
      expect(done.completedAt).toBeTruthy();
      expect(slowA.calls).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it('fails closed to INTERRUPTED when termination cannot be confirmed', { timeout: 120000 }, async () => {
    const gated = new GatedProcessManager();
    gated.terminationOutcome = 'TERMINATION_UNCONFIRMED';
    const { service, adapters } = makeService(
      (pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)],
      { processManager: gated }
    );
    const slowA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-cancel-unconfirmed') as never);
      await waitForState(service, start.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before cancel.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const cancel = await service.cancelJob({ jobId: start.jobId });
      expect(cancel.previousState).toBe('WORKER_RUNNING');
      expect(cancel.newState).toBe('INTERRUPTED');
      expect(cancel.recoveryRequired).toBe(false);

      const done = service.getJob({ jobId: start.jobId });
      expect(done.state).toBe('INTERRUPTED');
      expect(done.error).toContain('CANCELLATION_UNCONFIRMED');
      expect(done.completedAt).toBeTruthy();
      expect(gated.terminateCalls).toEqual([start.jobId, start.jobId]);

      gated.releaseAll();
      const after = await waitForTerminal(service, start.jobId);
      expect(after.state).toBe('INTERRUPTED');
    } finally {
      await service.stop();
    }
  });

  it('preserves a natural WORKER_RETURNED when no tracked process remained to terminate', { timeout: 120000 }, async () => {
    const gated = new GatedProcessManager();
    gated.terminationOutcome = 'NO_ACTIVE_PROCESS';
    const { service, adapters } = makeService(
      (pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)],
      { processManager: gated }
    );
    const slowA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-cancel-race') as never);
      await waitForState(service, start.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before cancel.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const cancelling = service.cancelJob({ jobId: start.jobId });
      gated.releaseAll();
      const cancel = await cancelling;
      expect(cancel.previousState).toBe('WORKER_RUNNING');
      expect(cancel.newState).toBe('WORKER_RETURNED');
      expect(cancel.recoveryRequired).toBe(false);

      const done = await waitForTerminal(service, start.jobId);
      expect(done.state).toBe('WORKER_RETURNED');
      expect(done.verification).toContain('READ_ONLY verified');
      expect(gated.terminateCalls).toEqual([start.jobId]);
    } finally {
      await service.stop();
    }
  });

  it('confirms cancellation when the worker process spawns during the settle window', { timeout: 120000 }, async () => {
    const gated = new GatedProcessManager();
    gated.terminationOutcomes = ['NO_ACTIVE_PROCESS', 'TERMINATED'];
    const { service, adapters } = makeService(
      (pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)],
      { processManager: gated }
    );
    const slowA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-cancel-late-spawn') as never);
      await waitForState(service, start.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before cancel.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const cancel = await service.cancelJob({ jobId: start.jobId });
      expect(cancel.previousState).toBe('WORKER_RUNNING');
      expect(cancel.newState).toBe('CANCELLED');

      const done = service.getJob({ jobId: start.jobId });
      expect(done.state).toBe('CANCELLED');
      expect(done.error).toContain('mechanically confirmed');
      expect(done.completedAt).toBeTruthy();
      expect(gated.terminateCalls).toEqual([start.jobId, start.jobId]);
      expect(gated.runCalls).toHaveLength(1);
    } finally {
      gated.releaseAll();
      await service.stop();
    }
  });

  it('treats a repeated cancel as a truthful no-op', { timeout: 120000 }, async () => {
    const gated = new GatedProcessManager();
    const { service, adapters } = makeService(
      (pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)],
      { processManager: gated }
    );
    const slowA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-cancel-twice') as never);
      await waitForState(service, start.jobId, 'WORKER_RUNNING');
      const invocationDeadline = Date.now() + 30_000;
      while (slowA.calls.length === 0) {
        if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before cancel.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const first = await service.cancelJob({ jobId: start.jobId });
      expect(first.previousState).toBe('WORKER_RUNNING');
      expect(first.newState).toBe('CANCELLED');

      const second = await service.cancelJob({ jobId: start.jobId });
      expect(second.previousState).toBe('CANCELLED');
      expect(second.newState).toBe('CANCELLED');
      expect(second.recoveryRequired).toBe(false);

      const done = service.getJob({ jobId: start.jobId });
      expect(done.state).toBe('CANCELLED');
      expect(gated.terminateCalls).toHaveLength(1);
      expect(gated.runCalls).toHaveLength(1);
    } finally {
      gated.releaseAll();
      await service.stop();
    }
  });

  it('persists terminal jobs and clientRequestId idempotency across service restarts', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'success', pm)]);
    const a = adapters[0];
    await service.start();
    let jobId: string;
    try {
      const start = service.startJob(startParams('durable-restart') as never);
      jobId = start.jobId;
      await waitForTerminal(service, jobId);
      expect(service.getJob({ jobId: jobId }).state).toBe('WORKER_RETURNED');
    } finally {
      await service.stop();
    }

    const { service: service2 } = makeService((pm) => [new DurableTestAdapter('mock-a', 'success', pm)]);
    await service2.start();
    try {
      const reloaded = service2.getJob({ jobId });
      expect(reloaded.state).toBe('WORKER_RETURNED');
      expect(reloaded.verification).toContain('READ_ONLY verified');
      const result = service2.getResult({ jobId });
      expect(result.resultText).toContain('plan from mock-a');

      const duplicate = service2.startJob(startParams('durable-restart') as never);
      expect(duplicate.jobId).toBe(jobId);
      expect(duplicate.state).toBe('WORKER_RETURNED');
      expect(a.calls).toHaveLength(1);
    } finally {
      await service2.stop();
    }
  });

  it('fails closed to INTERRUPTED when the service is reloaded while a job is in flight (no blind retry)', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)]);
    const slowA = adapters[0];
    await service.start();
    let jobId: string;
    const start = service.startJob(startParams('durable-inflight') as never);
    jobId = start.jobId;
    await waitForState(service, jobId, 'WORKER_RUNNING');
    const invocationDeadline = Date.now() + 30_000;
    while (slowA.calls.length === 0) {
      if (Date.now() > invocationDeadline) throw new Error('Worker was never invoked before reload.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(slowA.calls).toHaveLength(1);

    // Simulate a crash: the first service keeps running while a second service
    // loads the same durable storage.
    const { service: service2 } = makeService((pm) => [new DurableTestAdapter('mock-a', 'sleep', pm)]);
    await service2.start();
    try {
      const reloaded = service2.getJob({ jobId });
      expect(reloaded.state).toBe('INTERRUPTED');
      expect(reloaded.error).toContain('restarted');
      expect(slowA.calls).toHaveLength(1);
    } finally {
      await service2.stop();
    }
    await service.stop();
  });

  it('records a terminal FAILED state with the mutation evidence for a READ_ONLY violation', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'mutate', pm)]);
    const mutatingA = adapters[0];
    await service.start();
    try {
      const start = service.startJob(startParams('durable-mutate') as never);
      const done = await waitForTerminal(service, start.jobId);
      expect(done.state).toBe('FAILED');
      expect(done.error).toContain('read-only constraint');
      expect(done.changedFiles?.some((f) => f.includes('touched.js'))).toBe(true);
      expect(done.verification).toContain('READ_ONLY violation');

      const status = await execFileAsync('git', ['-C', repo, 'status', '--porcelain'], { windowsHide: true });
      expect(status.stdout.trim()).toBe('');
    } finally {
      await service.stop();
    }
  });

  it('reports truthful qualification for targets in list_targets', { timeout: 120000 }, async () => {
    const { service, adapters } = makeService((pm) => [new DurableTestAdapter('mock-a', 'success', pm)]);
    const a = adapters[0];
    await service.start();
    try {
      const targets = service.listTargets();
      expect(targets.targets.length).toBeGreaterThanOrEqual(2);
      const targetA = targets.targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.available).toBe(false);
      expect(targetA.qualification).toBe('UNKNOWN');

      const start = service.startJob(startParams('durable-qual') as never);
      await waitForTerminal(service, start.jobId);

      const after = service.listTargets();
      const targetAAfter = after.targets.find((t) => t.targetId === 'target_a')!;
      expect(targetAAfter.qualification).toBe('KNOWN_AVAILABLE');
      expect(targetAAfter.available).toBe(true);
    } finally {
      await service.stop();
    }
  });
});