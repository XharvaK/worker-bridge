import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../../src/config.js';
import { Ledger } from '../../src/engine/ledger.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';

const execFileAsync = promisify(execFile);

describe('Orchestrator End-to-End Workflow', () => {
  let tmpMailboxDir: string;
  let tmpRepoDir: string;
  let tmpWorkerRootDir: string;
  let tmpLedgerPath: string;
  let baseSha: string;
  const mockAgyCmd = path.resolve(__dirname, '../fixtures/mock-agy.cmd');

  beforeEach(async () => {
    tmpMailboxDir = path.join(os.tmpdir(), `test-e2e-mailbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpRepoDir = path.join(os.tmpdir(), `test-e2e-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpWorkerRootDir = path.join(os.tmpdir(), `test-e2e-workers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpLedgerPath = path.join(os.tmpdir(), `test-e2e-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    fs.mkdirSync(tmpMailboxDir, { recursive: true });
    fs.mkdirSync(tmpRepoDir, { recursive: true });
    fs.mkdirSync(tmpWorkerRootDir, { recursive: true });

    // Initialize Mailbox git repo
    await execFileAsync('git', ['-C', tmpMailboxDir, 'init', '-b', 'main'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'config', 'user.name', 'Mailbox User'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'config', 'user.email', 'mailbox@example.com'], { windowsHide: true });
    fs.writeFileSync(path.join(tmpMailboxDir, 'README.md'), '# Mailbox\n');
    await execFileAsync('git', ['-C', tmpMailboxDir, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpMailboxDir, 'commit', '-m', 'Init mailbox'], { windowsHide: true });

    // Initialize Target Project git repo
    await execFileAsync('git', ['-C', tmpRepoDir, 'init', '-b', 'master'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.name', 'Repo User'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.email', 'repo@example.com'], { windowsHide: true });
    fs.writeFileSync(path.join(tmpRepoDir, 'main.ts'), 'console.log("Ashley core");\n');
    await execFileAsync('git', ['-C', tmpRepoDir, 'add', 'main.ts'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'commit', '-m', 'Init target project'], { windowsHide: true });

    const { stdout } = await execFileAsync('git', ['-C', tmpRepoDir, 'rev-parse', 'HEAD'], { windowsHide: true });
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    delete process.env.MOCK_AGY_MODE;
    if (fs.existsSync(tmpMailboxDir)) {
      try {
        fs.rmSync(tmpMailboxDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(tmpRepoDir)) {
      try {
        fs.rmSync(tmpRepoDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(tmpWorkerRootDir)) {
      try {
        fs.rmSync(tmpWorkerRootDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(tmpLedgerPath)) {
      try {
        fs.unlinkSync(tmpLedgerPath);
      } catch {}
    }
  });

  it('executes PLAN, then IMPLEMENT after Sol review, and handles CANCEL with strict isolation', async () => {
    process.env.MOCK_AGY_MODE = 'success';

    const testConfig = {
      mailboxRepoPath: tmpMailboxDir,
      mailboxRemote: 'origin',
      pollIntervalSeconds: 1,
      workerRootDir: tmpWorkerRootDir,
      agyExecutable: mockAgyCmd,
      workerModel: 'flash',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {
        ashley: {
          path: tmpRepoDir,
          allowed: true,
        },
      },
    };

    const configManager = new ConfigManager(testConfig);
    const ledger = new Ledger(tmpLedgerPath);
    const orchestrator = new Orchestrator(configManager, ledger);

    // ==========================================
    // STEP 1: Sol creates a PLAN job in mailbox
    // ==========================================
    const jobDir = path.join(tmpMailboxDir, 'jobs', 'job-e2e-001');
    fs.mkdirSync(jobDir, { recursive: true });

    const planJobJson = {
      schemaVersion: 1,
      jobId: 'job-e2e-001',
      projectId: 'ashley',
      baseSha,
      requestedPhase: 'PLAN',
      revision: 1,
      workerSelection: {
        platform: 'antigravity',
        model: 'gemini-3.7-flash-high',
      },
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(planJobJson, null, 2), 'utf8');
    fs.writeFileSync(path.join(jobDir, 'goal.md'), 'Build new caching layer for Ashley.\n', 'utf8');

    // Run tick
    await orchestrator.tick();

    // Verify PLAN_READY
    const statusContent1 = fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    const status1 = JSON.parse(statusContent1);
    expect(status1.state).toBe('PLAN_READY');
    expect(status1.observedPhase).toBe('PLAN');

    const planContent = fs.readFileSync(path.join(jobDir, 'plan.md'), 'utf8');
    expect(planContent).toContain('Generated Implementation Plan');

    // Idempotency: tick again without changes -> should not re-run
    await orchestrator.tick();
    const statusContent1Recheck = fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    expect(JSON.parse(statusContent1Recheck).state).toBe('PLAN_READY');

    // ==========================================
    // STEP 2: Sol reviews plan and requests IMPLEMENT
    // ==========================================
    process.env.MOCK_AGY_MODE = 'implement';

    fs.writeFileSync(
      path.join(jobDir, 'review.md'),
      'Approved with corrections: Ensure cache invalidation TTL is 60s.\n',
      'utf8'
    );

    const implementJobJson = {
      ...planJobJson,
      requestedPhase: 'IMPLEMENT',
      revision: 2,
    };
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(implementJobJson, null, 2), 'utf8');

    // Run tick
    await orchestrator.tick();

    // Verify IMPLEMENTATION_READY
    const statusContent2 = fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    const status2 = JSON.parse(statusContent2);
    expect(status2.state).toBe('IMPLEMENTATION_READY');
    expect(status2.observedPhase).toBe('IMPLEMENT');
    expect(status2.workerBranch).toBe('worker/ashley/job-e2e-001');

    const resultContent = fs.readFileSync(path.join(jobDir, 'result.md'), 'utf8');
    expect(resultContent).toContain('Implementation Result: `job-e2e-001`');

    // Verify target repo worker branch has the commit, while master is unchanged!
    const { stdout: workerBranchFiles } = await execFileAsync('git', [
      '-C',
      tmpRepoDir,
      'ls-tree',
      '-r',
      'worker/ashley/job-e2e-001',
      '--name-only',
    ], { windowsHide: true });
    expect(workerBranchFiles).toContain('implemented_code.js');

    const { stdout: masterFiles } = await execFileAsync('git', [
      '-C',
      tmpRepoDir,
      'ls-tree',
      '-r',
      'master',
      '--name-only',
    ], { windowsHide: true });
    expect(masterFiles).not.toContain('implemented_code.js');

    // ==========================================
    // STEP 3: Test CANCEL job
    // ==========================================
    const cancelJobDir = path.join(tmpMailboxDir, 'jobs', 'job-e2e-cancel');
    fs.mkdirSync(cancelJobDir, { recursive: true });

    const cancelJobJson = {
      schemaVersion: 1,
      jobId: 'job-e2e-cancel',
      projectId: 'ashley',
      baseSha,
      requestedPhase: 'CANCEL',
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(cancelJobDir, 'job.json'), JSON.stringify(cancelJobJson, null, 2), 'utf8');

    await orchestrator.tick();

    const cancelStatus = JSON.parse(fs.readFileSync(path.join(cancelJobDir, 'status.json'), 'utf8'));
    expect(cancelStatus.state).toBe('CANCELLED');
  }, 20000);
});
