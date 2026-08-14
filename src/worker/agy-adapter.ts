import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { ProcessManager, ProcessRunResult } from '../engine/process-manager.js';
import { AgyPermissionProfile, JobPhase } from '../types.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGY_PATH = 'C:\\Users\\Xharv\\AppData\\Local\\agy\\bin\\agy.exe';
export const DEFAULT_WORKER_MODEL = 'gemini-3.7-flash-high';

export class AgyAdapter {
  private agyExecutable: string;
  private workerModel: string;
  private processManager: ProcessManager;

  constructor(agyExecutable = DEFAULT_AGY_PATH, workerModel = DEFAULT_WORKER_MODEL, processManager?: ProcessManager) {
    this.agyExecutable = agyExecutable;
    this.workerModel = workerModel;
    this.processManager = processManager || new ProcessManager();
  }

  getExecutablePath(): string {
    return this.agyExecutable;
  }

  getModel(): string {
    return this.workerModel;
  }

  getJobLogFilePath(jobId: string): string {
    const logsDir = path.join(USER_BRIDGE_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${jobId}.log`);
  }

  static getPlanProfile(): AgyPermissionProfile {
    return {
      phase: 'PLAN',
      allowSourceWrites: false,
      allowNetworkActuation: false,
      allowElevation: false,
      allowSsh: false,
      allowGitPush: false,
      sandboxed: true,
    };
  }

  static getImplementProfile(): AgyPermissionProfile {
    return {
      phase: 'IMPLEMENT',
      allowSourceWrites: true,
      allowNetworkActuation: false,
      allowElevation: false,
      allowSsh: false,
      allowGitPush: false,
      sandboxed: true,
    };
  }

  buildInvocationArgs(promptText: string, worktreeCwd: string, profile: AgyPermissionProfile): string[] {
    const args: string[] = [];

    // Official AGY CLI flags:
    // Non-interactive print mode with prompt
    args.push('-p', promptText);

    // Exact model identifier
    args.push('--model', this.workerModel);

    // Reasoning effort set to high for Flash High
    args.push('--effort', 'high');

    // Execution mode: built-in 'plan' vs 'accept-edits'
    if (profile.phase === 'PLAN') {
      args.push('--mode', 'plan');
    } else {
      args.push('--mode', 'accept-edits');
    }

    // Enable terminal restrictions / OS sandbox
    if (profile.sandboxed) {
      args.push('--sandbox');
    }

    // Explicitly add worktree directory to workspace
    args.push('--add-dir', worktreeCwd);

    return args;
  }

  async checkAgyInstalled(): Promise<{ installed: boolean; path?: string; version?: string; error?: string }> {
    try {
      const isCmd = process.platform === 'win32' && /\.(bat|cmd)$/i.test(this.agyExecutable);
      const { stdout } = await execFileAsync(this.agyExecutable, ['--version'], {
        windowsHide: true,
        shell: isCmd,
      });
      return { installed: true, path: this.agyExecutable, version: stdout.trim() };
    } catch (err: any) {
      if (process.platform === 'win32') {
        try {
          const { stdout: whereOut } = await execFileAsync('where.exe', ['agy.exe', 'agy'], { windowsHide: true });
          const foundPath = whereOut.split(/\r?\n/)[0].trim();
          if (foundPath) {
            return { installed: true, path: foundPath };
          }
        } catch {}
      }
      return {
        installed: false,
        error: `AGY_CLI_MISSING: The official Antigravity CLI ("agy") was not found at "${this.agyExecutable}".`,
      };
    }
  }

  async invokeAgent(
    jobId: string,
    worktreeCwd: string,
    profile: AgyPermissionProfile,
    promptText: string,
    timeoutSeconds = 900
  ): Promise<ProcessRunResult> {
    const logFilePath = this.getJobLogFilePath(jobId);
    fs.writeFileSync(
      logFilePath,
      `=== Execution Started: ${new Date().toISOString()} ===\nPhase: ${profile.phase}\nModel: ${this.workerModel}\nWorktree: ${worktreeCwd}\nSandbox: ${profile.sandboxed}\nMode: ${profile.phase === 'PLAN' ? 'plan' : 'accept-edits'}\n\n`,
      'utf8'
    );

    const args = this.buildInvocationArgs(promptText, worktreeCwd, profile);

    logger.info(`Invoking official AGY worker for job ${jobId} (Model: ${this.workerModel}, Phase: ${profile.phase}) in ${worktreeCwd}`);

    const result = await this.processManager.run(jobId, {
      executable: this.agyExecutable,
      args,
      cwd: worktreeCwd,
      timeoutSeconds,
      onStdout: (chunk) => {
        fs.appendFileSync(logFilePath, chunk, 'utf8');
      },
      onStderr: (chunk) => {
        fs.appendFileSync(logFilePath, `[STDERR] ${chunk}`, 'utf8');
      },
    });

    fs.appendFileSync(
      logFilePath,
      `\n=== Execution Finished: ${new Date().toISOString()} (Exit Code: ${result.exitCode}) ===\n`,
      'utf8'
    );
    return result;
  }
}
