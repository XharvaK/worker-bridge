import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeManager } from '../../src/git/worktree.js';
import { isWorkingTreeClean } from '../../src/git/repo-guard.js';

const execFileAsync = promisify(execFile);

describe('WorktreeManager & Git Isolation', () => {
  let tmpRepoDir: string;
  let tmpWorkerRootDir: string;
  let baseSha: string;

  beforeEach(async () => {
    tmpRepoDir = path.join(os.tmpdir(), `test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpWorkerRootDir = path.join(os.tmpdir(), `test-workers-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    fs.mkdirSync(tmpRepoDir, { recursive: true });
    fs.mkdirSync(tmpWorkerRootDir, { recursive: true });

    // Initialize git repo
    await execFileAsync('git', ['-C', tmpRepoDir, 'init', '-b', 'master'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.name', 'Test Runner'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'config', 'user.email', 'test@example.com'], { windowsHide: true });

    fs.writeFileSync(path.join(tmpRepoDir, 'README.md'), '# Original Repo Content\n');
    await execFileAsync('git', ['-C', tmpRepoDir, 'add', 'README.md'], { windowsHide: true });
    await execFileAsync('git', ['-C', tmpRepoDir, 'commit', '-m', 'Initial commit'], { windowsHide: true });

    const { stdout } = await execFileAsync('git', ['-C', tmpRepoDir, 'rev-parse', 'HEAD'], { windowsHide: true });
    baseSha = stdout.trim();
  });

  afterEach(async () => {
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

  it('creates an isolated detached PLAN worktree and cleans it up', async () => {
    const manager = new WorktreeManager(tmpWorkerRootDir);
    const planWorktree = await manager.createPlanWorktree(tmpRepoDir, 'testproj', 'job-plan-001', baseSha);

    expect(fs.existsSync(planWorktree)).toBe(true);
    expect(fs.existsSync(path.join(planWorktree, 'README.md'))).toBe(true);

    const status = await isWorkingTreeClean(planWorktree);
    expect(status.clean).toBe(true);

    await manager.forceCleanupWorktree(tmpRepoDir, planWorktree);
    expect(fs.existsSync(planWorktree)).toBe(false);
  });

  it('creates an IMPLEMENT worktree, allows edits, commits on worker branch without touching master', async () => {
    const manager = new WorktreeManager(tmpWorkerRootDir);
    const { worktreePath, workerBranch } = await manager.createImplementWorktree(
      tmpRepoDir,
      'testproj',
      'job-imp-001',
      baseSha
    );

    expect(workerBranch).toBe('worker/testproj/job-imp-001');
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Edit file in worktree
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'Gemini worker implementation\n');

    const result = await manager.commitAndPushWorkerBranch(
      worktreePath,
      workerBranch,
      'feat: implement feature',
      false
    );

    expect(result.headSha).toBeDefined();
    expect(result.headSha).not.toBe(baseSha);

    // Verify master in original repo is completely unchanged
    const { stdout: masterSha } = await execFileAsync('git', ['-C', tmpRepoDir, 'rev-parse', 'master'], {
      windowsHide: true,
    });
    expect(masterSha.trim()).toBe(baseSha);
    expect(fs.existsSync(path.join(tmpRepoDir, 'feature.txt'))).toBe(false);

    await manager.forceCleanupWorktree(tmpRepoDir, worktreePath);
  });
});
