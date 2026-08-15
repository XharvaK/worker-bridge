import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../../src/config.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { Ledger } from '../../src/engine/ledger.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../../src/types.js';

const execFileAsync = promisify(execFile);

class RecoveryTestAdapter implements WorkerAdapter {
  readonly supportsCrossModelSessionContinuation = false;
  readonly calls: WorkerInvocationRequest[] = [];

  constructor(
    readonly platformId: string,
    private readonly mode: 'quota-read' | 'quota-write' | 'quota-write-no-effects' | 'success'
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
    if (this.mode === 'quota-read' || this.mode === 'quota-write' || this.mode === 'quota-write-no-effects') {
      if (this.mode === 'quota-write' && request.executionMode === 'WORKTREE_WRITE') {
        fs.writeFileSync(path.join(request.worktreeCwd, 'partial-source.js'), 'export const partial = true;\n');
      }
      return {
        platformId: this.platformId,
        modelId: request.modelId,
        variant: request.variant,
        exitCode: 1,
        responseText: 'quota exhausted after partial work',
        artifactsCreated: [],
        startedAt: now,
        completedAt: now,
        failureClass: request.executionMode === 'READ_ONLY' || this.mode === 'quota-write' || this.mode === 'quota-write-no-effects'
          ? 'QUOTA_EXHAUSTED'
          : undefined,
        retryAt: new Date(Date.now() + 3600_000).toISOString(),
        rawFailureEvidence: 'quota exhausted; retry-after: 3600',
        requestPrompt: request.promptText,
        evidence: {
          stdout: 'partial response',
          stderr: 'quota exhausted; retry-after: 3600',
          partialResponse: 'partial response',
          outputTruncated: false,
          sessionId: `session-${this.platformId}`,
          lastMeaningfulAction: this.mode === 'quota-write' ? 'write partial-source.js' : 'read repository',
        },
      };
    }
    if (request.executionMode === 'WORKTREE_WRITE') {
      fs.writeFileSync(path.join(request.worktreeCwd, 'completed-source.js'), 'export const completed = true;\n');
    }
    return {
      platformId: this.platformId,
      modelId: request.modelId,
      variant: request.variant,
      exitCode: 0,
      responseText: 'completed',
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

describe('Recovery-aware fallback orchestration', () => {
  let root: string;
  let repo: string;
  let mailbox: string;
  let workers: string;
  let baseSha: string;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bridge-recovery-'));
    repo = path.join(root, 'repo');
    mailbox = path.join(root, 'mailbox');
    workers = path.join(root, 'workers');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(mailbox, { recursive: true });
    fs.mkdirSync(workers, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Recovery Test'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'recovery@test.local'], { cwd: repo, windowsHide: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Recovery test\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo, windowsHide: true });
    const sha = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true });
    baseSha = sha.stdout.trim();
    await execFileAsync('git', ['init'], { cwd: mailbox, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Mailbox Test'], { cwd: mailbox, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'mailbox@test.local'], { cwd: mailbox, windowsHide: true });
    fs.writeFileSync(path.join(mailbox, 'README.md'), '# Mailbox\n');
    await execFileAsync('git', ['add', '.'], { cwd: mailbox, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: mailbox, windowsHide: true });
    worktreeManager = new WorktreeManager(workers);
  });

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeConfig(): ConfigManager {
    return new ConfigManager({
      mailboxRepoPath: mailbox,
      workerRootDir: workers,
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {
        recovery: { path: repo, allowed: true, defaultBranch: 'master', allowPushWorkerBranch: false },
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
          codex_explicit: {
            targetId: 'codex_explicit',
            platformId: 'codex',
            modelId: 'codex-model',
            displayName: 'Fixture Codex',
            aliases: ['codex', 'codex-model'],
            reasoning: { strategy: 'highest-supported' },
            explicitOnly: true,
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

  function makeRegistry(a: RecoveryTestAdapter, b: RecoveryTestAdapter, codex?: RecoveryTestAdapter): AdapterRegistry {
    const registry = new AdapterRegistry();
    registry.register(a);
    registry.register(b);
    if (codex) registry.register(codex);
    return registry;
  }

  async function initMailboxJob(jobId: string, spec: Record<string, unknown>, files: Record<string, string>): Promise<string> {
    const jobDir = path.join(mailbox, 'jobs', jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(spec, null, 2));
    for (const [filename, content] of Object.entries(files)) fs.writeFileSync(path.join(jobDir, filename), content);
    return jobDir;
  }

  it('falls back across eligible targets after a read-only quota failure', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'quota-read');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const jobId = 'job-read-fallback';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
      workerSelection: { model: 'auto' },
    }, { 'brief.md': 'Produce a plan.\n' });
    const availabilityPath = path.join(root, 'availability.json');
    const orchestrator = new Orchestrator(
      makeConfig(),
      new Ledger(path.join(root, 'ledger.json')),
      makeRegistry(a, b),
      new TargetAvailabilityLedger(availabilityPath)
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('WORKER_RETURNED');
    expect(status.currentWorker.targetId).toBe('target_b');
    const planCapsule = JSON.parse(
      fs.readFileSync(path.join(jobDir, 'rounds', '001', 'recovery-capsule.json'), 'utf8')
    );
    expect(planCapsule.contract.originalGoal).toBe('Produce a plan.\n');
    expect(planCapsule.contract.revision).toBe(1);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(new TargetAvailabilityLedger(availabilityPath).get('target_a')?.state).toBe('COOLDOWN');
  });

  it('does not silently fall back from an explicit target binding', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'quota-read');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const jobId = 'job-explicit-target-no-fallback';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
      workerSelection: { targetId: 'target_a' },
    }, { 'brief.md': 'Produce a plan.\n' });
    const orchestrator = new Orchestrator(
      makeConfig(),
      new Ledger(path.join(root, 'ledger-explicit.json')),
      makeRegistry(a, b),
      new TargetAvailabilityLedger(path.join(root, 'availability-explicit.json'))
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('FAILED');
    expect(status.currentWorker.targetId).toBe('target_a');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('blocks CONTINUE without an exact persisted session ID before invoking a worker', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'success');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const jobId = 'job-continue-without-session';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
      workerSelection: { targetId: 'target_a' },
      sessionPolicy: 'CONTINUE',
    }, { 'brief.md': 'Continue only when the exact session is available.\n' });
    const orchestrator = new Orchestrator(
      makeConfig(),
      new Ledger(path.join(root, 'ledger-continue-without-session.json')),
      makeRegistry(a, b),
      new TargetAvailabilityLedger(path.join(root, 'availability-continue-without-session.json'))
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('BLOCKED');
    expect(status.error).toMatch(/SESSION_ID_UNAVAILABLE/);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('allows an explicitly authorized Codex fallback for a read-only quota failure', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'quota-read');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const codex = new RecoveryTestAdapter('codex', 'success');
    const jobId = 'job-explicit-codex-read-fallback';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
      workerSelection: {
        targetId: 'target_a',
        fallbackSelection: { targetId: 'codex_explicit', platform: 'codex', model: 'codex-model' },
      },
    }, { 'brief.md': 'Produce a plan with an explicit fallback.\n' });
    const orchestrator = new Orchestrator(
      makeConfig(),
      new Ledger(path.join(root, 'ledger-codex-read.json')),
      makeRegistry(a, b, codex),
      new TargetAvailabilityLedger(path.join(root, 'availability-codex-read.json'))
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('WORKER_RETURNED');
    expect(status.currentWorker.targetId).toBe('codex_explicit');
    expect(a.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('allows an explicitly authorized Codex fallback for a write quota failure with no source effects', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'quota-write-no-effects');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const codex = new RecoveryTestAdapter('codex', 'success');
    const jobId = 'job-explicit-codex-write-fallback';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'implement',
      executionMode: 'WORKTREE_WRITE',
      round: 1,
      revision: 1,
      workerSelection: {
        targetId: 'target_a',
        fallbackSelection: { targetId: 'codex_explicit', platform: 'codex', model: 'codex-model' },
      },
      ownerApproval: { approved: true, approvedBy: 'Doc' },
    }, {
      'brief.md': 'Implement the approved change.\n',
      'plan.md': 'Write the source change.\n',
      'review.md': 'Approved.\n',
    });
    const orchestrator = new Orchestrator(
      makeConfig(),
      new Ledger(path.join(root, 'ledger-codex-write.json')),
      makeRegistry(a, b, codex),
      new TargetAvailabilityLedger(path.join(root, 'availability-codex-write.json'))
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(status.state).toBe('WORKER_RETURNED');
    expect(status.currentWorker.targetId).toBe('codex_explicit');
    expect(a.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it('stops write fallback after source effects and publishes an interrupted recovery state', async () => {
    const a = new RecoveryTestAdapter('mock-a', 'quota-write');
    const b = new RecoveryTestAdapter('mock-b', 'success');
    const codex = new RecoveryTestAdapter('codex', 'success');
    const jobId = 'job-write-interrupted';
    const jobDir = await initMailboxJob(jobId, {
      schemaVersion: 2,
      jobId,
      projectId: 'recovery',
      baseSha,
      intent: 'implement',
      executionMode: 'WORKTREE_WRITE',
      round: 1,
      revision: 1,
      workerSelection: {
        targetId: 'target_a',
        fallbackSelection: { targetId: 'codex_explicit', platform: 'codex', model: 'codex-model' },
      },
      ownerApproval: { approved: true, approvedBy: 'Doc' },
    }, {
      'brief.md': 'Implement the approved change.\n',
      'plan.md': 'Write the source change.\n',
      'review.md': 'Approved.\n',
    });
    const ledger = new Ledger(path.join(root, 'ledger.json'));
    const orchestrator = new Orchestrator(
      makeConfig(),
      ledger,
      makeRegistry(a, b, codex),
      new TargetAvailabilityLedger(path.join(root, 'availability.json'))
    );

    await orchestrator.tick();

    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    const record = ledger.getJobRecord(jobId);
    expect(status.state).toBe('INTERRUPTED_WITH_SOURCE_STATE');
    expect(status.recoveryCapsulePath).toContain('recovery-capsule.json');
    expect(record?.sourceEffectsPresent).toBe(true);
    expect(record?.worktreePath).toBeTruthy();
    expect(fs.existsSync(record!.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(record!.worktreePath!, 'partial-source.js'))).toBe(true);
    expect(b.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
    const implementationCapsule = JSON.parse(
      fs.readFileSync(path.join(jobDir, 'rounds', '001', 'recovery-capsule.json'), 'utf8')
    );
    expect(implementationCapsule.contract.revision).toBe(1);
    expect(implementationCapsule.contract.ownerApproval.approved).toBe(true);
    expect(implementationCapsule.sourceWorker).toMatchObject({
      targetId: 'target_a',
      platform: 'mock-a',
      model: 'mock-a-model',
      reasoning: 'high',
      sessionId: 'session-mock-a',
    });
    expect(implementationCapsule.currentState.worktreePath).toBe(record!.worktreePath);

    fs.writeFileSync(
      path.join(jobDir, 'job.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          jobId,
          projectId: 'recovery',
          baseSha,
          intent: 'implement',
          executionMode: 'WORKTREE_WRITE',
          round: 2,
          revision: 1,
          workerSelection: { model: 'auto' },
          recovery: { enabled: true, fromRound: 1 },
          ownerApproval: { approved: true, approvedBy: 'Doc' },
        },
        null,
        2
      )
    );
    await orchestrator.tick();

    const recoveryStatus = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8'));
    expect(recoveryStatus.state).toBe('WORKER_RETURNED');
    expect(recoveryStatus.currentWorker.targetId).toBe('target_b');
    expect(b.calls).toHaveLength(1);
    const { stdout: recoveredFile } = await execFileAsync(
      'git',
      ['show', `worker/recovery/${jobId}:partial-source.js`],
      { cwd: repo, windowsHide: true }
    );
    expect(recoveredFile).toContain('partial');

    const finalRecord = ledger.getJobRecord(jobId);
    expect(finalRecord?.worktreePath).toBeNull();
    await worktreeManager.forceCleanupWorktree(repo, record!.worktreePath!);
  });
});
