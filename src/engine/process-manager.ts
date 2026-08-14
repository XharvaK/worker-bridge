import { spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';

const execFileAsync = promisify(execFile);

export interface ProcessRunOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  pid: number | null;
}

export class ProcessManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();

  isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async killProcessTree(pid: number): Promise<void> {
    if (!pid || pid <= 0) return;
    try {
      logger.info(`Killing process tree for PID ${pid}`);
      await execFileAsync('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
        windowsHide: true,
      });
    } catch (err: any) {
      logger.debug(`taskkill error (process may already be dead): ${err.message || String(err)}`);
    }
  }

  async run(jobId: string, options: ProcessRunOptions): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      // On Windows, use shell: true for .cmd/.bat scripts to ensure correct execution
      const useShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(options.executable);

      const child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        shell: useShell,
      });

      const pid = child.pid || null;
      if (pid) {
        this.activeProcesses.set(jobId, child);
      }

      if (options.timeoutSeconds && options.timeoutSeconds > 0) {
        timeoutHandle = setTimeout(async () => {
          timedOut = true;
          logger.warn(`Job ${jobId} timed out after ${options.timeoutSeconds}s. Terminating process tree.`);
          if (pid) {
            await this.killProcessTree(pid);
          }
        }, options.timeoutSeconds * 1000);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutAcc += text;
        if (options.onStdout) {
          options.onStdout(sanitizeSecrets(text));
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrAcc += text;
        if (options.onStderr) {
          options.onStderr(sanitizeSecrets(text));
        }
      });

      child.on('error', (err) => {
        logger.error(`Process error for job ${jobId}: ${err.message}`);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcesses.delete(jobId);
        resolve({
          exitCode: 1,
          stdout: sanitizeSecrets(stdoutAcc),
          stderr: sanitizeSecrets(stderrAcc + `\nProcess error: ${err.message}`),
          timedOut,
          pid,
        });
      });

      child.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcesses.delete(jobId);
        resolve({
          exitCode: code ?? (timedOut ? 124 : 0),
          stdout: sanitizeSecrets(stdoutAcc),
          stderr: sanitizeSecrets(stderrAcc),
          timedOut,
          pid,
        });
      });
    });
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const child = this.activeProcesses.get(jobId);
    if (child && child.pid) {
      logger.info(`Cancelling active process for job ${jobId} (PID: ${child.pid})`);
      await this.killProcessTree(child.pid);
      this.activeProcesses.delete(jobId);
      return true;
    }
    return false;
  }
}
