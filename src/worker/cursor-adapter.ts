import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { ProcessManager } from '../engine/process-manager.js';
import {
  DiscoveredModel,
  ExecutionMode,
  QuotaProbeResult,
  ReasoningStrategy,
  WorkerInvocationRequest,
  WorkerRoundResult,
  WorkerSessionIdentity,
} from '../types.js';
import { WorkerAdapter, WorkerAdapterError, WorkerPlatformInfo, analyzeOperationalError } from './worker-adapter.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CURSOR_PATH = 'cursor-agent';
export const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-xhigh';

export interface CursorExecutableResolution {
  nativeExecutable: string;
  cliScript?: string;
  isCmdWrapper: boolean;
  wrapperPath?: string;
  flavor: 'cursor-agent' | 'cursor-desktop';
}

export class CursorAdapter implements WorkerAdapter {
  readonly platformId = 'cursor-cli';
  readonly supportsCrossModelSessionContinuation = false;
  private cursorConfiguredPath: string;
  private defaultModel: string;
  private processManager: ProcessManager;
  private resolvedExecutable: string | null = null;
  private resolvedCliScript: string | null = null;
  private resolvedFlavor: 'cursor-agent' | 'cursor-desktop' = 'cursor-agent';
  private cachedModels: DiscoveredModel[] | null = null;
  private cacheTimestamp = 0;

  constructor(
    cursorExecutable = DEFAULT_CURSOR_PATH,
    defaultModel = DEFAULT_CURSOR_MODEL,
    processManager?: ProcessManager
  ) {
    this.cursorConfiguredPath = cursorExecutable;
    this.defaultModel = defaultModel;
    this.processManager = processManager || new ProcessManager();
  }

  getExecutablePath(): string {
    return this.resolvedExecutable || this.cursorConfiguredPath;
  }

  getModel(): string {
    return this.defaultModel;
  }

  getJobLogFilePath(jobId: string): string {
    const logsDir = path.join(USER_BRIDGE_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${jobId}-cursor-cli.log`);
  }

  /**
   * Resolves the native binary target without invoking cmd.exe or shell=true.
   */
  resolveDirectExecutable(): CursorExecutableResolution | null {
    if (this.resolvedExecutable) {
      return {
        nativeExecutable: this.resolvedExecutable,
        cliScript: this.resolvedCliScript || undefined,
        isCmdWrapper: false,
        flavor: this.resolvedFlavor,
      };
    }

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Xharv\\AppData\\Local';

      // 1. Preferred resolution: Cursor Agent standalone CLI bundled node + index.js
      const agentBase = path.join(localAppData, 'cursor-agent');
      const versionsDir = path.join(agentBase, 'versions');
      if (fs.existsSync(versionsDir)) {
        try {
          const versions = fs.readdirSync(versionsDir).sort().reverse();
          for (const ver of versions) {
            const nodeExe = path.join(versionsDir, ver, 'node.exe');
            const indexJs = path.join(versionsDir, ver, 'index.js');
            if (fs.existsSync(nodeExe) && fs.existsSync(indexJs)) {
              this.resolvedExecutable = nodeExe;
              this.resolvedCliScript = indexJs;
              this.resolvedFlavor = 'cursor-agent';
              return {
                nativeExecutable: nodeExe,
                cliScript: indexJs,
                isCmdWrapper: false,
                flavor: 'cursor-agent',
              };
            }
          }
        } catch {
          // ignore and fall through
        }
      }

      // 2. Secondary resolution: Cursor Desktop Electron binary + cli.js
      const desktopDir = path.join(localAppData, 'Programs\\cursor');
      const cursorExe = path.join(desktopDir, 'Cursor.exe');
      const cliJs = path.join(desktopDir, 'resources\\app\\out\\cli.js');
      const cursorCmd = path.join(desktopDir, 'resources\\app\\bin\\cursor.cmd');

      if (fs.existsSync(cursorExe) && fs.existsSync(cliJs)) {
        this.resolvedExecutable = cursorExe;
        this.resolvedCliScript = cliJs;
        this.resolvedFlavor = 'cursor-desktop';
        return {
          nativeExecutable: cursorExe,
          cliScript: cliJs,
          isCmdWrapper: false,
          wrapperPath: fs.existsSync(cursorCmd) ? cursorCmd : undefined,
          flavor: 'cursor-desktop',
        };
      }
    }

    // 3. Configured explicit path
    if (fs.existsSync(this.cursorConfiguredPath)) {
      const ext = path.extname(this.cursorConfiguredPath).toLowerCase();
      if (ext === '.exe') {
        this.resolvedExecutable = this.cursorConfiguredPath;
        this.resolvedFlavor = 'cursor-agent';
        return {
          nativeExecutable: this.cursorConfiguredPath,
          isCmdWrapper: false,
          flavor: 'cursor-agent',
        };
      }
    }

    return null;
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    const resolution = this.resolveDirectExecutable();
    if (!resolution) {
      return {
        platformId: this.platformId,
        displayName: 'Cursor CLI',
        installed: false,
        executablePath: this.cursorConfiguredPath,
        error: `CURSOR_CLI_MISSING: Native Cursor executable could not be resolved from "${this.cursorConfiguredPath}".`,
      };
    }

    try {
      const args = resolution.cliScript ? [resolution.cliScript, '--version'] : ['--version'];
      const { stdout } = await execFileAsync(resolution.nativeExecutable, args, {
        windowsHide: true,
        shell: false,
        timeout: 10000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CURSOR_API_KEY: '', // clear invalid env key to ensure stored auth tokens are used
        },
      });

      const version = stdout.trim().split(/\r?\n/)[0];
      return {
        platformId: this.platformId,
        displayName: 'Cursor CLI',
        installed: true,
        version: version || 'unknown',
        executablePath: resolution.nativeExecutable,
      };
    } catch (err: any) {
      return {
        platformId: this.platformId,
        displayName: 'Cursor CLI',
        installed: false,
        executablePath: resolution.nativeExecutable,
        error: `CURSOR_CLI_INSPECTION_FAILED: Failed to execute native Cursor CLI: ${err.message || String(err)}`,
      };
    }
  }

  async discoverModels(refresh = false): Promise<DiscoveredModel[]> {
    const now = Date.now();
    if (!refresh && this.cachedModels && now - this.cacheTimestamp < 300000) {
      return this.cachedModels;
    }

    // Authenticated Cursor Agent model catalog identities
    const discovered: DiscoveredModel[] = [
      {
        id: 'cursor-grok-4.6-xhigh',
        displayName: 'Cursor Grok 4.6 Extra High',
        family: 'grok',
        variants: [],
        selectability: 'SELECTABLE',
      },
      {
        id: 'cursor-grok-4.6-medium',
        displayName: 'Cursor Grok 4.6 Medium',
        family: 'grok',
        variants: [],
        selectability: 'SELECTABLE',
      },
      {
        id: 'cursor-grok-4.6-high',
        displayName: 'Cursor Grok 4.6',
        family: 'grok',
        variants: [],
        selectability: 'SELECTABLE',
      },
      {
        id: 'cursor-grok-4.6-low-fast',
        displayName: 'Cursor Grok 4.6 Low Fast',
        family: 'grok',
        variants: [],
        selectability: 'SELECTABLE',
      },
      {
        id: 'grok-4.6',
        displayName: 'Grok 4.6',
        family: 'grok',
        variants: [],
        selectability: 'SELECTABLE',
      },
    ];

    this.cachedModels = discovered;
    this.cacheTimestamp = now;
    return discovered;
  }

  async resolveReasoningProfile(
    _modelId: string,
    _requestedStrategy: ReasoningStrategy = 'highest-supported',
    _explicitValue?: string
  ): Promise<string | undefined> {
    // Exact Cursor models (such as cursor-grok-4.6-xhigh and cursor-grok-4.6-medium)
    // already encode their reasoning depth directly in the model ID.
    return undefined;
  }

  async probeQuota(_modelId?: string): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN', details: 'Cursor CLI quota is provider-managed and not queried via pre-run endpoint.' };
  }

  buildInvocationArgs(
    promptText: string,
    worktreeCwd: string,
    executionMode: ExecutionMode,
    modelId: string,
    _variant?: string,
    sessionId?: string
  ): string[] {
    const args: string[] = [];

    if (this.resolvedCliScript) {
      args.push(this.resolvedCliScript);
    }

    if (this.resolvedFlavor === 'cursor-agent') {
      args.push('-p');
      args.push('--output-format', 'text');
      args.push('--trust');
      args.push('--workspace', worktreeCwd);
      args.push('--model', modelId || this.defaultModel);

      if (executionMode === 'READ_ONLY') {
        args.push('--mode', 'ask');
      }

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      args.push(promptText);
    } else {
      args.push('agent');

      if (executionMode === 'READ_ONLY') {
        args.push('--mode=ask');
      } else {
        args.push('--mode=agent');
      }

      args.push('--dir', worktreeCwd);
      args.push('-m', modelId || this.defaultModel);

      if (sessionId) {
        args.push('--session', sessionId);
      }

      args.push('-p', promptText);
    }

    return args;
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    const startedAt = new Date().toISOString();
    const model = request.modelId || this.defaultModel;
    const logFilePath = this.getJobLogFilePath(request.jobId);

    const envInfo = await this.inspectEnvironment();
    if (!envInfo.installed) {
      throw new WorkerAdapterError('CLI_MISSING', envInfo.error || 'Cursor CLI is not installed.');
    }

    fs.writeFileSync(
      logFilePath,
      `=== Execution Started: ${startedAt} ===\nPlatform: ${this.platformId}\nExecutionMode: ${request.executionMode}\nModel: ${model}\nWorktree: ${request.worktreeCwd}\nSessionId: ${request.sessionId || 'none'}\n\n`,
      'utf8'
    );

    const args = this.buildInvocationArgs(
      request.promptText,
      request.worktreeCwd,
      request.executionMode,
      model,
      request.variant,
      request.sessionId
    );

    logger.info(
      `Invoking Cursor CLI worker for job ${request.jobId} (Model: ${model}, Mode: ${request.executionMode}) in ${request.worktreeCwd}`
    );

    // Injected environment ensures native execution, clears stale keys, and propagates lineage
    const lineageEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ELECTRON_RUN_AS_NODE: '1',
      CURSOR_API_KEY: '',
      WORKER_BRIDGE_PARENT_JOB_ID: request.jobId,
      WORKER_BRIDGE_EXECUTION_DEPTH: '1',
      WORKER_BRIDGE_EXECUTION_CONTEXT: 'worker-child',
    };

    const executableToRun = this.resolvedExecutable || this.cursorConfiguredPath;

    const result = await this.processManager.run(request.jobId, {
      executable: executableToRun,
      args,
      cwd: request.worktreeCwd,
      env: lineageEnv,
      timeoutSeconds: request.timeoutSeconds || 900,
      onStdout: (chunk) => {
        fs.appendFileSync(logFilePath, chunk, 'utf8');
      },
      onStderr: (chunk) => {
        fs.appendFileSync(logFilePath, `[STDERR] ${chunk}`, 'utf8');
      },
    });

    const completedAt = new Date().toISOString();
    fs.appendFileSync(
      logFilePath,
      `\n=== Execution Finished: ${completedAt} (Exit Code: ${result.exitCode}) ===\n`,
      'utf8'
    );

    const failure =
      result.exitCode !== 0 || result.timedOut
        ? analyzeOperationalError(result.exitCode, result.stdout, result.stderr, result.timedOut, startedAt)
        : undefined;

    const sessionIdentity: WorkerSessionIdentity = {
      targetId: request.targetId,
      platform: this.platformId,
      model,
      reasoning: undefined,
      sessionId: request.sessionId,
      worktreeCwd: request.worktreeCwd,
      executionMode: request.executionMode,
    };

    return {
      platformId: this.platformId,
      modelId: model,
      variant: undefined,
      platformSessionId: request.sessionId,
      exitCode: result.exitCode,
      responseText: result.stdout.trim(),
      artifactsCreated: [],
      toolSummary: {},
      startedAt,
      completedAt,
      failureClass: failure?.failureClass,
      retryAt: failure?.retryAt,
      rawFailureEvidence: failure?.rawEvidence,
      requestPrompt: request.promptText,
      rawStderr: result.stderr,
      sessionIdentity,
      evidence: {
        stdout: result.stdout,
        stderr: result.stderr,
        partialResponse: result.stdout.trim(),
        outputTruncated: result.outputTruncated,
        sessionId: request.sessionId,
      },
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.processManager.cancelJob(jobId);
  }
}
