import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeManager } from '../../src/git/worktree.js';
import { ProcessManager } from '../../src/engine/process-manager.js';
import { AgyAdapter } from '../../src/worker/agy-adapter.js';
import { PlanWorker } from '../../src/worker/plan-worker.js';
import { isWorkingTreeClean } from '../../src/git/repo-guard.js';

const execFileAsync = promisify(execFile);

describe('PlanWorker Isolation & Mechanical Read-Only Enforcement', () => {
  let tmpRepoDir: string;
  let tmpWorkerRootDir: string;
  let baseSha: string;
  const mockAgyCmd = path.resolve(__dirname, '../fixtures/mock-agy.cmd');

  beforeEach(async () => {
    tmpRepoDir = path.join(os.tmpdir(), `test-plan-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpWorkerRootDir = path.join(os.tmpdir(), `test-plan-workers-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    fs.mkdirSync(tmpRepoDir, { recursive: true });
    fs.mkdirSync(tmpWorkerRootDir, { recursive: true });

    await execFileAsync('git', ['-C', tmpRepoDir, 'init', '-b', 'master'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.name', 'Test Runner'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.email', 'test@example.com'], { windowsHide: true });

    fs.writeFileSync(path.join(tmpRepoDir, 'app.ts'), 'export const version = "1.0.0";\n');
    await execFileAsync('git', ['-C', tmpRepoDir, 'add', 'app.ts'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'commit', '-m', 'Initial commit'], { windowsHide: true });

    const { stdout } = await execFileAsync('git', ['-C', tmpRepoDir, 'rev-parse', 'HEAD'], { windowsHide: true });
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    delete process.env.MOCK_AGY_MODE;
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
  });

  it('generates a clean plan when worker obeys read-only constraints', async () => {
    process.env.MOCK_AGY_MODE = 'success';

    const worktreeManager = new WorktreeManager(tmpWorkerRootDir);
    const processManager = new ProcessManager();
    const agyAdapter = new AgyAdapter(mockAgyCmd, 'flash', processManager);
    const planWorker = new PlanWorker(worktreeManager, agyAdapter);

    const result = await planWorker.execute(
      'job-plan-clean',
      'testproj',
      tmpRepoDir,
      baseSha,
      'Add user authentication'
    );

    expect(result.clean).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.planText).toContain('Generated Implementation Plan');
    expect(result.mutatedFiles.length).toBe(0);

    // Primary repo must remain completely clean
    const status = await isWorkingTreeClean(tmpRepoDir);
    expect(status.clean).toBe(true);
  });

  it('detects and rejects file mutations during PLAN mode, returning clean: false and error', async () => {
    process.env.MOCK_AGY_MODE = 'violate_plan';

    const worktreeManager = new WorktreeManager(tmpWorkerRootDir);
    const processManager = new ProcessManager();
    const agyAdapter = new AgyAdapter(mockAgyCmd, 'flash', processManager);
    const planWorker = new PlanWorker(worktreeManager, agyAdapter);

    const result = await planWorker.execute(
      'job-plan-violation',
      'testproj',
      tmpRepoDir,
      baseSha,
      'Add illegal modification'
    );

    expect(result.clean).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('PLAN mode violated read-only constraint');
    expect(result.mutatedFiles).toContain('?? illegal_modification.txt');

    // Primary repo must remain untouched and clean
    const status = await isWorkingTreeClean(tmpRepoDir);
    expect(status.clean).toBe(true);
    expect(fs.existsSync(path.join(tmpRepoDir, 'illegal_modification.txt'))).toBe(false);
  });
});
