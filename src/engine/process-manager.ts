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
  stdinText?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  pid: number | null;
  outputTruncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface SafeProcessInvocation {
  executable: string;
  args: string[];
}

/** @internal Test fixture only. Production workers must use direct binaries. */
export function getSafeProcessInvocation(executable: string, args: string[]): SafeProcessInvocation {
  const isWindowsBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(executable);
  return isWindowsBatch
    ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { executable, args };
}

function appendBounded(current: string, incoming: string, maxBytes: number): { value: string; truncated: boolean } {
  const combined = current + incoming;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return { value: combined, truncated: false };

  const marker = '\n...[output truncated]...\n';
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const headBytes = Math.ceil(available / 2);
  const tailBytes = Math.floor(available / 2);
  const combinedBytes = Buffer.from(combined, 'utf8');
  const tail = tailBytes > 0 ? combinedBytes.subarray(-tailBytes).toString('utf8') : '';
  return {
    value: `${combinedBytes.subarray(0, headBytes).toString('utf8')}${marker}${tail}`,
    truncated: true,
  };
}

function sanitizeBounded(value: string, maxBytes: number): { value: string; truncated: boolean } {
  return appendBounded('', sanitizeSecrets(value), maxBytes);
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
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

      // Batch files cannot be executed directly by CreateProcess. Invoke them through
      // ComSpec with shell disabled so provider prompt text is never reparsed by an
      // ambient shell. Node quotes the remaining argument array for CreateProcess.
      const invocation = getSafeProcessInvocation(options.executable, options.args);

      const currentDepth = Number(process.env.WORKER_BRIDGE_EXECUTION_DEPTH || 0);
      const lineageEnv: Record<string, string> = {
        WORKER_BRIDGE_PARENT_JOB_ID: jobId,
        WORKER_BRIDGE_EXECUTION_DEPTH: (currentDepth + 1).toString(),
        WORKER_BRIDGE_EXECUTION_CONTEXT: 'worker-child',
      };

      const child = spawn(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: { ...process.env, ...lineageEnv, ...options.env },
        windowsHide: true,
        shell: false,
      });

      if (options.stdinText !== undefined) {
        child.stdin?.end(options.stdinText);
      }

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
        const bounded = appendBounded(stdoutAcc, text, maxOutputBytes);
        stdoutAcc = bounded.value;
        stdoutTruncated = stdoutTruncated || bounded.truncated;
        if (options.onStdout) {
          options.onStdout(sanitizeSecrets(text));
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const bounded = appendBounded(stderrAcc, text, maxOutputBytes);
        stderrAcc = bounded.value;
        stderrTruncated = stderrTruncated || bounded.truncated;
        if (options.onStderr) {
          options.onStderr(sanitizeSecrets(text));
        }
      });

      child.on('error', (err) => {
        logger.error(`Process error for job ${jobId}: ${err.message}`);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcesses.delete(jobId);
        const stdout = sanitizeBounded(stdoutAcc, maxOutputBytes);
        const stderr = sanitizeBounded(stderrAcc + `\nProcess error: ${err.message}`, maxOutputBytes);
        resolve({
          exitCode: 1,
          stdout: stdout.value,
          stderr: stderr.value,
          timedOut,
          pid,
          outputTruncated: stdoutTruncated || stderrTruncated || stdout.truncated || stderr.truncated,
        });
      });

      child.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcesses.delete(jobId);
        const stdout = sanitizeBounded(stdoutAcc, maxOutputBytes);
        const stderr = sanitizeBounded(stderrAcc, maxOutputBytes);
        resolve({
          exitCode: code ?? (timedOut ? 124 : 0),
          stdout: stdout.value,
          stderr: stderr.value,
          timedOut,
          pid,
          outputTruncated: stdoutTruncated || stderrTruncated || stdout.truncated || stderr.truncated,
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
