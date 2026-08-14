import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../../src/config.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { Ledger } from '../../src/engine/ledger.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../../src/types.js';

const execFileAsync = promisify(execFile);

class MockWorkerAdapter implements WorkerAdapter {
  readonly platformId: string;
  readonly calls: WorkerInvocationRequest[] = [];

  constructor(platformId: string) {
    this.platformId = platformId;
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return {
      platformId: this.platformId,
      displayName: `Mock ${this.platformId}`,
      installed: true,
      executablePath: `mock-${this.platformId}`,
    };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.platformId}-model-1`,
        displayName: `${this.platformId} Model 1`,
        variants: ['high'],
        highestVariant: 'high',
      },
    ];
  }

  async resolveReasoningProfile(): Promise<string | undefined> {
    return 'high';
  }

  async probeQuota(): Promise<QuotaProbeResult> {
    return { state: 'AVAILABLE' };
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    this.calls.push(request);
    const startedAt = new Date().toISOString();
    if (request.executionMode === 'WORKTREE_WRITE') {
      fs.writeFileSync(
        path.join(request.worktreeCwd, 'solution.js'),
        `// Implemented on ${this.platformId}\nexport const result = 100;\n`,
        'utf8'
      );
    }

    return {
      platformId: this.platformId,
      modelId: request.modelId || `${this.platformId}-model-1`,
      variant: request.variant || 'high',
      platformSessionId: `sess-${this.platformId}-${request.roundNumber}`,
      exitCode: 0,
      responseText: `# ${this.platformId} Output for round ${request.roundNumber}\nSuccessfully executed ${request.executionMode}.`,
      artifactsCreated: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

describe('Multi-Round Cross-Platform Orchestration Flow', () => {
  let tmpBaseDir: string;
  let targetRepoDir: string;
  let mailboxDir: string;
  let workersDir: string;
  let targetBaseSha: string;

  beforeEach(async () => {
    tmpBaseDir = path.join(
      os.tmpdir(),
      `test-multi-round-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    targetRepoDir = path.join(tmpBaseDir, 'target-project');
    mailboxDir = path.join(tmpBaseDir, 'mailbox');
    workersDir = path.join(tmpBaseDir, 'workers');

    fs.mkdirSync(targetRepoDir, { recursive: true });
    fs.mkdirSync(mailboxDir, { recursive: true });
    fs.mkdirSync(workersDir, { recursive: true });

    // Init target git repo
    await execFileAsync('git', ['init'], { cwd: targetRepoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'BridgeTester'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.email', 'tester@workerbridge.local'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });

    fs.writeFileSync(path.join(targetRepoDir, 'README.md'), '# Target Project\n');
    await execFileAsync('git', ['add', '.'], { cwd: targetRepoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });

    const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: targetRepoDir,
      windowsHide: true,
    });
    targetBaseSha = shaOut.trim();

    // Init mailbox git repo
    await execFileAsync('git', ['init'], { cwd: mailboxDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'MailboxBot'], {
      cwd: mailboxDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.email', 'mailbox@local'], {
      cwd: mailboxDir,
      windowsHide: true,
    });
    fs.writeFileSync(path.join(mailboxDir, 'README.md'), '# Mailbox\n');
    await execFileAsync('git', ['add', '.'], { cwd: mailboxDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'Initial mailbox'], {
      cwd: mailboxDir,
      windowsHide: true,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpBaseDir)) {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('executes Round 1 on Antigravity (plan), then Round 2 on OpenCode (implement) with owner approval', async () => {
    const configManager = new ConfigManager({
      mailboxRepoPath: mailboxDir,
      workerRootDir: workersDir,
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {
        targetproj: {
          path: targetRepoDir,
          allowed: true,
          defaultBranch: 'master',
          allowPushWorkerBranch: false,
        },
      },
      selectionPolicy: {
        targets: {
          test_antigravity_model_1: {
            targetId: 'test_antigravity_model_1',
            platformId: 'antigravity',
            modelId: 'antigravity-model-1',
            displayName: 'Test Antigravity Model 1',
            aliases: ['antigravity-model-1'],
            reasoning: { strategy: 'highest-supported' },
          },
          test_opencode_model_1: {
            targetId: 'test_opencode_model_1',
            platformId: 'opencode',
            modelId: 'opencode-model-1',
            displayName: 'Test OpenCode Model 1',
            aliases: ['opencode-model-1'],
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {
          PLANNER: ['test_antigravity_model_1'],
          INVESTIGATOR: ['test_antigravity_model_1'],
          WORKER: ['test_opencode_model_1'],
          REVIEWER: ['test_opencode_model_1'],
        },
      },
    });

    const customRegistry = new AdapterRegistry();
    customRegistry.register(new MockWorkerAdapter('antigravity'));
    customRegistry.register(new MockWorkerAdapter('opencode'));

    const customLedger = new Ledger(path.join(tmpBaseDir, 'test-ledger.json'));
    const orchestrator = new Orchestrator(configManager, customLedger, customRegistry);

    // ==========================================
    // ROUND 1: Antigravity Plan (READ_ONLY)
    // ==========================================
    const jobId = 'job-multi-001';
    const jobDir = path.join(mailboxDir, 'jobs', jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const round1Spec = {
      schemaVersion: 2,
      jobId,
      projectId: 'targetproj',
      baseSha: targetBaseSha,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
      workerSelection: {
        platform: 'antigravity',
        model: 'antigravity-model-1',
      },
      sessionPolicy: 'FRESH',
    };

    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(round1Spec, null, 2));
    fs.writeFileSync(path.join(jobDir, 'brief.md'), '# Implementation Brief\nCreate solution.js\n');

    await orchestrator.tick();

    // Verify Round 1 Status
    const status1Raw = fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    const status1 = JSON.parse(status1Raw);
    expect(status1.state).toBe('WORKER_RETURNED');
    expect(status1.currentWorker.platform).toBe('antigravity');
    expect(status1.currentWorker.reasoning).toBe('high');

    // ==========================================
    // SOL REVIEW & OWNER APPROVAL
    // ==========================================
    fs.writeFileSync(
      path.join(jobDir, 'review.md'),
      '# Sol Review\nApproved with correction: ensure export const result = 100;\n'
    );

    // ==========================================
    // ROUND 2: OpenCode Implementation (WORKTREE_WRITE)
    // ==========================================
    const round2Spec = {
      schemaVersion: 2,
      jobId,
      projectId: 'targetproj',
      baseSha: targetBaseSha,
      intent: 'implement',
      executionMode: 'WORKTREE_WRITE',
      round: 2,
      revision: 1,
      workerSelection: {
        platform: 'opencode',
        model: 'opencode-model-1',
      },
      sessionPolicy: 'FRESH',
      ownerApproval: {
        approved: true,
        approvedBy: 'Doc',
        approvedAt: new Date().toISOString(),
      },
    };

    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(round2Spec, null, 2));

    await orchestrator.tick();

    // Verify Round 2 Status
    const status2Raw = fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    const status2 = JSON.parse(status2Raw);
    expect(status2.state).toBe('WORKER_RETURNED');
    expect(status2.currentWorker.platform).toBe('opencode');
    expect(status2.currentWorker.reasoning).toBe('high');
    expect(status2.workerBranch).toBe(`worker/targetproj/${jobId}`);
    expect(customLedger.getJobRecord(jobId)?.reasoning).toBe('high');
    expect(customRegistry.get('opencode')).toBeDefined();

    // Verify target repo worker branch was created with commit
    const { stdout: branchCheck } = await execFileAsync(
      'git',
      ['branch', '--list', `worker/targetproj/${jobId}`],
      { cwd: targetRepoDir, windowsHide: true }
    );
    expect(branchCheck.trim()).toContain(`worker/targetproj/${jobId}`);
  }, 30000);
});
