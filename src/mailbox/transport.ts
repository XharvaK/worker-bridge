import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface TransportSyncResult {
  ok: boolean;
  conflict?: boolean;
  error?: string;
}

export class MailboxTransport {
  private repoPath: string;
  private remote: string;
  private branch: string;

  constructor(repoPath: string, remote = 'origin', branch = 'main') {
    this.repoPath = path.resolve(repoPath);
    this.remote = remote;
    this.branch = branch;
  }

  async hasRemote(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.repoPath, 'remote'], { windowsHide: true });
      const remotes = stdout.split(/\r?\n/).map(r => r.trim());
      return remotes.includes(this.remote);
    } catch {
      return false;
    }
  }

  async fetchAndRebase(): Promise<TransportSyncResult> {
    const hasRem = await this.hasRemote();
    if (!hasRem) {
      return { ok: true };
    }

    try {
      await execFileAsync('git', ['-C', this.repoPath, 'fetch', this.remote], { windowsHide: true });
    } catch (err: any) {
      logger.warn(`Mailbox fetch warning: ${err.message || String(err)}`);
      return { ok: false, error: err.message };
    }

    try {
      await execFileAsync('git', ['-C', this.repoPath, 'pull', '--rebase', this.remote, this.branch], {
        windowsHide: true,
      });
      return { ok: true };
    } catch (err: any) {
      const errMsg = (err.stdout || '') + (err.stderr || '') + (err.message || '') + String(err);
      const isConflict = /CONFLICT|Failed to merge|could not apply|Resolve all conflicts|patch failed/i.test(errMsg);

      if (isConflict) {
        logger.error(`Mailbox Git conflict detected during rebase. Aborting rebase to preserve local state.`);
        try {
          await execFileAsync('git', ['-C', this.repoPath, 'rebase', '--abort'], { windowsHide: true });
        } catch {}
        return { ok: false, conflict: true, error: `mailbox_git_conflict: ${errMsg.trim()}` };
      }

      logger.warn(`Mailbox rebase warning: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  async stageAndCommitJobArtifacts(jobId: string, message: string): Promise<boolean> {
    try {
      const jobRelDir = path.join('jobs', jobId);
      await execFileAsync('git', ['-C', this.repoPath, 'add', jobRelDir], { windowsHide: true });

      const { stdout: status } = await execFileAsync('git', ['-C', this.repoPath, 'status', '--porcelain'], {
        windowsHide: true,
      });

      if (status.trim().length === 0) {
        return false; // Nothing changed
      }

      await execFileAsync('git', ['-C', this.repoPath, 'commit', '-m', message], { windowsHide: true });
      return true;
    } catch (err) {
      logger.error(`Failed to stage/commit job artifacts for ${jobId}: ${String(err)}`);
      return false;
    }
  }

  async pushWithRetry(maxRetries = 3): Promise<TransportSyncResult> {
    const hasRem = await this.hasRemote();
    if (!hasRem) {
      return { ok: true };
    }

    let delayMs = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'push', this.remote, this.branch], {
          windowsHide: true,
        });
        return { ok: true };
      } catch (err: any) {
        logger.warn(`Push to mailbox failed (attempt ${attempt}/${maxRetries}): ${err.message || String(err)}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          const rebaseRes = await this.fetchAndRebase();
          if (rebaseRes.conflict) {
            // Do not retry on semantic conflict
            return rebaseRes;
          }
        }
      }
    }
    return { ok: false, error: 'Push attempts exhausted' };
  }
}
