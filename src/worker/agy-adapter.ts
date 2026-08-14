import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { ProcessManager, ProcessRunResult } from '../engine/process-manager.js';
import { AgyPermissionProfile, JobPhase } from '../types.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export class AgyAdapter {
  private agyExecutable: string;
  private workerModel: string;
  private processManager: ProcessManager;

  constructor(agyExecutable: string, workerModel: string, processManager: ProcessManager) {
    this.agyExecutable = agyExecutable;
    this.workerModel = workerModel;
    this.processManager = processManager;
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

    // Official AGY CLI syntax:
    // Headless one-shot prompt
    args.push('-p', promptText);

    // Working directory bound to isolated worktree
    args.push('--cwd', worktreeCwd);

    // Configured official worker model
    args.push('--model', this.workerModel);

    // Enable terminal sandbox
    if (profile.sandboxed) {
      args.push('--sandbox');
    }

    // Preventative Permission Controls:
    // When in PLAN mode, forbid file writes and mutation tools
    if (!profile.allowSourceWrites) {
      args.push('--permission:fs:write=deny');
      args.push('--permission:tools:write_file=deny');
      args.push('--permission:tools:replace_file_content=deny');
      args.push('--permission:tools:multi_replace_file_content=deny');
    }

    // Network / Browser actuation denied for headless worker
    if (!profile.allowNetworkActuation) {
      args.push('--permission:browser=deny');
      args.push('--permission:network=deny');
    }

    // Explicitly prohibit git push / elevation tools
    if (!profile.allowGitPush) {
      args.push('--permission:git:push=deny');
    }
    if (!profile.allowElevation) {
      args.push('--permission:elevation=deny');
    }
    if (!profile.allowSsh) {
      args.push('--permission:ssh=deny');
    }

    return args;
  }

  async checkAgyInstalled(): Promise<{ installed: boolean; path?: string; version?: string; error?: string }> {
    try {
      // Check if executable is directly resolvable or in PATH
      const { stdout } = await execFileAsync(this.agyExecutable, ['--version'], {
        windowsHide: true,
        shell: process.platform === 'win32' && /\.(bat|cmd)$/i.test(this.agyExecutable),
      });
      return { installed: true, path: this.agyExecutable, version: stdout.trim() };
    } catch (err: any) {
      // If direct check failed, check where.exe on Windows
      if (process.platform === 'win32') {
        try {
          const { stdout: whereOut } = await execFileAsync('where.exe', [this.agyExecutable], { windowsHide: true });
          const foundPath = whereOut.split(/\r?\n/)[0].trim();
          if (foundPath) {
            return { installed: true, path: foundPath };
          }
        } catch {
          // not in PATH
        }
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
      `=== Execution Started: ${new Date().toISOString()} ===\nPhase: ${profile.phase}\nModel: ${this.workerModel}\nWorktree: ${worktreeCwd}\nSandbox: ${profile.sandboxed}\nAllowWrites: ${profile.allowSourceWrites}\n\n`,
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
