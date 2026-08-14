import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertNotProtectedBranch } from './repo-guard.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  private workerRootDir: string;

  constructor(workerRootDir: string) {
    this.workerRootDir = path.resolve(workerRootDir);
    if (!fs.existsSync(this.workerRootDir)) {
      fs.mkdirSync(this.workerRootDir, { recursive: true });
    }
  }

  getPlanWorktreePath(projectId: string, jobId: string): string {
    return path.join(this.workerRootDir, `${projectId}-${jobId}-plan`);
  }

  getImplementWorktreePath(projectId: string, jobId: string): string {
    return path.join(this.workerRootDir, `${projectId}-${jobId}`);
  }

  getWorkerBranchName(projectId: string, jobId: string): string {
    return `worker/${projectId}/${jobId}`;
  }

  async createPlanWorktree(repoPath: string, projectId: string, jobId: string, baseSha: string): Promise<string> {
    const worktreePath = this.getPlanWorktreePath(projectId, jobId);
    await this.forceCleanupWorktree(repoPath, worktreePath);

    logger.info(`Creating detached PLAN worktree at ${worktreePath} (base SHA: ${baseSha})`);
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, baseSha], {
      windowsHide: true,
    });
    return worktreePath;
  }

  async createImplementWorktree(
    repoPath: string,
    projectId: string,
    jobId: string,
    baseSha: string
  ): Promise<{ worktreePath: string; workerBranch: string }> {
    const worktreePath = this.getImplementWorktreePath(projectId, jobId);
    const workerBranch = this.getWorkerBranchName(projectId, jobId);

    assertNotProtectedBranch(workerBranch);
    await this.forceCleanupWorktree(repoPath, worktreePath);

    // Create or reset worker branch to baseSha
    try {
      await execFileAsync('git', ['-C', repoPath, 'branch', '-f', workerBranch, baseSha], {
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(`Failed to create worker branch "${workerBranch}" from base SHA "${baseSha}": ${String(err)}`);
    }

    logger.info(`Creating IMPLEMENT worktree at ${worktreePath} on branch ${workerBranch}`);
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, workerBranch], {
      windowsHide: true,
    });

    return { worktreePath, workerBranch };
  }

  async forceCleanupWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
        windowsHide: true,
      });
    } catch {
      // Ignore if worktree was not registered in git
    }

    try {
      await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], {
        windowsHide: true,
      });
    } catch {
      // Ignore
    }

    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Failed to completely remove directory ${worktreePath}: ${String(err)}`);
      }
    }
  }

  async commitAndPushWorkerBranch(
    worktreePath: string,
    workerBranch: string,
    commitMessage: string,
    shouldPush: boolean,
    remote = 'origin'
  ): Promise<{ headSha: string; pushed: boolean }> {
    assertNotProtectedBranch(workerBranch);

    // Stage all changes
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A'], { windowsHide: true });

    // Check if there is anything to commit
    const { stdout: status } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      windowsHide: true,
    });

    if (status.trim().length > 0) {
      await execFileAsync('git', ['-C', worktreePath, 'commit', '-m', commitMessage], { windowsHide: true });
    }

    const { stdout: headShaOut } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
      windowsHide: true,
    });
    const headSha = headShaOut.trim();

    let pushed = false;
    if (shouldPush) {
      assertNotProtectedBranch(workerBranch);
      logger.info(`Pushing worker branch ${workerBranch} to ${remote}`);
      await execFileAsync('git', ['-C', worktreePath, 'push', '-u', remote, workerBranch], { windowsHide: true });
      pushed = true;
    }

    return { headSha, pushed };
  }
}
