import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { getSafeProcessInvocation, ProcessManager, ProcessRunResult } from '../engine/process-manager.js';
import {
  DiscoveredModel,
  ExecutionMode,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../types.js';
import { WorkerAdapter, WorkerPlatformInfo, analyzeOperationalError } from './worker-adapter.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGY_PATH = 'C:\\Users\\Xharv\\AppData\\Local\\agy\\bin\\agy.exe';
export const DEFAULT_AGY_MODEL = 'gemini-3.7-flash-high';

export interface AgyLegacyPermissionProfile {
  phase?: 'PLAN' | 'IMPLEMENT';
  executionMode?: ExecutionMode;
  allowSourceWrites: boolean;
  allowNetworkActuation: boolean;
  allowElevation: boolean;
  allowSsh: boolean;
  allowGitPush: boolean;
  sandboxed: boolean;
}

export class AntigravityAdapter implements WorkerAdapter {
  readonly platformId = 'antigravity';
  private agyExecutable: string;
  private defaultModel: string;
  private processManager: ProcessManager;
  private cachedModels: DiscoveredModel[] | null = null;
  private cacheTimestamp = 0;

  constructor(
    agyExecutable = DEFAULT_AGY_PATH,
    defaultModel = DEFAULT_AGY_MODEL,
    processManager?: ProcessManager
  ) {
    this.agyExecutable = agyExecutable;
    this.defaultModel = defaultModel;
    this.processManager = processManager || new ProcessManager();
  }

  getExecutablePath(): string {
    return this.agyExecutable;
  }

  getModel(): string {
    return this.defaultModel;
  }

  getJobLogFilePath(jobId: string): string {
    const logsDir = path.join(USER_BRIDGE_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${jobId}.log`);
  }

  static getPlanProfile(): AgyLegacyPermissionProfile {
    return {
      executionMode: 'READ_ONLY',
      phase: 'PLAN',
      allowSourceWrites: false,
      allowNetworkActuation: false,
      allowElevation: false,
      allowSsh: false,
      allowGitPush: false,
      sandboxed: true,
    };
  }

  static getImplementProfile(): AgyLegacyPermissionProfile {
    return {
      executionMode: 'WORKTREE_WRITE',
      phase: 'IMPLEMENT',
      allowSourceWrites: true,
      allowNetworkActuation: false,
      allowElevation: false,
      allowSsh: false,
      allowGitPush: false,
      sandboxed: true,
    };
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    const tryRun = async (exe: string): Promise<string | undefined> => {
      try {
        const invocation = getSafeProcessInvocation(exe, ['--version']);
        const { stdout } = await execFileAsync(invocation.executable, invocation.args, {
          windowsHide: true,
          shell: false,
        });
        return stdout.trim();
      } catch {
        return undefined;
      }
    };

    const directVer = await tryRun(this.agyExecutable);
    if (directVer) {
      return {
        platformId: this.platformId,
        displayName: 'Google Antigravity',
        installed: true,
        version: directVer,
        executablePath: this.agyExecutable,
      };
    }

    const isDefaultOrGeneric =
      this.agyExecutable === 'agy.exe' ||
      this.agyExecutable === 'agy' ||
      this.agyExecutable === DEFAULT_AGY_PATH;

    if (process.platform === 'win32' && isDefaultOrGeneric) {
      if (fs.existsSync(DEFAULT_AGY_PATH)) {
        const defVer = await tryRun(DEFAULT_AGY_PATH);
        if (defVer) {
          this.agyExecutable = DEFAULT_AGY_PATH;
          return {
            platformId: this.platformId,
            displayName: 'Google Antigravity',
            installed: true,
            version: defVer,
            executablePath: DEFAULT_AGY_PATH,
          };
        }
      }

      try {
        const { stdout: whereOut } = await execFileAsync('where.exe', ['agy.exe', 'agy'], {
          windowsHide: true,
        });
        const foundPath = whereOut.split(/\r?\n/)[0].trim();
        if (foundPath) {
          this.agyExecutable = foundPath;
          const ver = (await tryRun(foundPath)) || '1.1.13';
          return {
            platformId: this.platformId,
            displayName: 'Google Antigravity',
            installed: true,
            version: ver,
            executablePath: foundPath,
          };
        }
      } catch {}
    }

    return {
      platformId: this.platformId,
      displayName: 'Google Antigravity',
      installed: false,
      executablePath: this.agyExecutable,
      error: `AGY_CLI_MISSING: The official Antigravity CLI ("agy") was not found at "${this.agyExecutable}".`,
    };
  }

  async checkAgyInstalled(): Promise<{ installed: boolean; path?: string; version?: string; error?: string }> {
    const env = await this.inspectEnvironment();
    return {
      installed: env.installed,
      path: env.executablePath,
      version: env.version,
      error: env.error,
    };
  }

  async discoverModels(refresh = false): Promise<DiscoveredModel[]> {
    const now = Date.now();
    if (!refresh && this.cachedModels && now - this.cacheTimestamp < 300000) {
      return this.cachedModels;
    }

    try {
      const invocation = getSafeProcessInvocation(this.agyExecutable, ['models']);
      const { stdout } = await execFileAsync(invocation.executable, invocation.args, {
        windowsHide: true,
        shell: false,
        timeout: 10000,
      });

      const models: DiscoveredModel[] = [];
      const lines = stdout.split(/\r?\n/);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Fetching')) continue;
        const parts = trimmed.split(/\t+/);
        const id = parts[0]?.trim();
        const displayName = parts[1]?.trim() || id;

        if (id) {
          const isOpus = id.toLowerCase().includes('opus');
          const variants = ['low', 'medium', 'high'];
          models.push({
            id,
            displayName,
            family: id.split('-')[0],
            variants,
            highestVariant: 'high',
            isExplicitOnly: isOpus,
          });
        }
      }

      if (models.length > 0) {
        this.cachedModels = models;
        this.cacheTimestamp = now;
        return models;
      }
    } catch (err) {
      logger.debug(`Could not dynamically fetch AGY models via CLI: ${String(err)}`);
    }

    // Fallback baseline discovered models
    const fallbackModels: DiscoveredModel[] = [
      { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash (High)', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash (Medium)', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'gemini-3.7-flash-low', displayName: 'Gemini 3.7 Flash (Low)', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', variants: ['low', 'high'], highestVariant: 'high' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', variants: [], highestVariant: undefined },
      { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)', variants: [], highestVariant: undefined, isExplicitOnly: true },
      { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', variants: [], highestVariant: undefined },
    ];
    this.cachedModels = fallbackModels;
    this.cacheTimestamp = now;
    return fallbackModels;
  }

  async resolveReasoningProfile(
    _modelId: string,
    requestedStrategy: 'highest-supported' | 'explicit' = 'highest-supported',
    explicitValue?: string
  ): Promise<string | undefined> {
    if (requestedStrategy === 'explicit' && explicitValue) {
      return explicitValue;
    }
    return 'high';
  }

  async probeQuota(_modelId?: string): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN', details: 'Antigravity quota is not available via machine-readable CLI endpoint' };
  }

  buildInvocationArgs(
    promptText: string,
    worktreeCwd: string,
    modeOrProfile?: ExecutionMode | AgyLegacyPermissionProfile,
    modelId?: string,
    effort = 'high',
    sessionId?: string
  ): string[] {
    let executionMode: ExecutionMode = 'READ_ONLY';
    let sandboxed = true;

    if (typeof modeOrProfile === 'string') {
      executionMode = modeOrProfile;
    } else if (modeOrProfile && typeof modeOrProfile === 'object') {
      sandboxed = modeOrProfile.sandboxed ?? true;
      if (modeOrProfile.phase === 'IMPLEMENT' || modeOrProfile.executionMode === 'WORKTREE_WRITE') {
        executionMode = 'WORKTREE_WRITE';
      } else {
        executionMode = 'READ_ONLY';
      }
    }

    const args: string[] = [];

    // Official AGY 1.1.13 CLI flags:
    // Non-interactive print mode with prompt
    args.push('-p', promptText);

    // Exact model identifier
    args.push('--model', modelId || this.defaultModel);

    // Reasoning effort
    args.push('--effort', effort || 'high');

    // Execution mode: built-in 'plan' vs 'accept-edits'
    if (executionMode === 'READ_ONLY') {
      args.push('--mode', 'plan');
    } else {
      args.push('--mode', 'accept-edits');
    }

    // Enable terminal restrictions / OS sandbox
    if (sandboxed) {
      args.push('--sandbox');
    }

    // Explicitly add worktree directory to workspace
    args.push('--add-dir', worktreeCwd);

    // Session continuation if provided
    if (sessionId) {
      args.push('--conversation', sessionId);
    }

    return args;
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    const startedAt = new Date().toISOString();
    const model = request.modelId || this.defaultModel;
    const effort = request.variant || 'high';
    const logFilePath = this.getJobLogFilePath(request.jobId);

    fs.writeFileSync(
      logFilePath,
      `=== Execution Started: ${startedAt} ===\nPlatform: ${this.platformId}\nExecutionMode: ${request.executionMode}\nModel: ${model}\nEffort: ${effort}\nWorktree: ${request.worktreeCwd}\n\n`,
      'utf8'
    );

    const args = this.buildInvocationArgs(
      request.promptText,
      request.worktreeCwd,
      request.executionMode,
      model,
      effort,
      request.sessionId
    );

    logger.info(
      `Invoking official AGY worker for job ${request.jobId} (Model: ${model}, Mode: ${request.executionMode}) in ${request.worktreeCwd}`
    );

      const result = await this.processManager.run(request.jobId, {
      executable: this.agyExecutable,
      args,
      cwd: request.worktreeCwd,
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
    const lastMeaningfulAction = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    const conversationMatch = `${result.stdout}\n${result.stderr}`.match(
      /conversation(?:id|_id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i
    );

    const artifactsCreated: string[] = [];
    const artifactMatch = result.stdout.matchAll(/\[(?:plan\.md|implementation_plan\.md|result\.md)\]\((?:file:\/\/\/)?([^)]+)\)/gi);
    for (const match of artifactMatch) {
      if (match[1]) {
        artifactsCreated.push(decodeURIComponent(match[1].replace(/^file:\/\/\//i, '')));
      }
    }

    return {
      platformId: this.platformId,
      modelId: model,
      variant: effort,
      platformSessionId: conversationMatch?.[1],
      exitCode: result.exitCode,
      responseText: result.stdout.trim(),
      artifactsCreated,
      startedAt,
      completedAt,
      failureClass: failure?.failureClass,
      retryAt: failure?.retryAt,
      rawFailureEvidence: failure?.rawEvidence,
      requestPrompt: request.promptText,
      evidence: {
        stdout: result.stdout,
        stderr: result.stderr,
        partialResponse: result.stdout,
        outputTruncated: result.outputTruncated,
        lastMeaningfulAction,
        sessionId: conversationMatch?.[1],
      },
      rawStderr: result.stderr,
    };
  }

  async invokeAgent(
    jobId: string,
    worktreeCwd: string,
    profile: AgyLegacyPermissionProfile,
    promptText: string,
    timeoutSeconds = 900
  ): Promise<ProcessRunResult> {
    const mode = profile.executionMode || (profile.phase === 'PLAN' ? 'READ_ONLY' : 'WORKTREE_WRITE');
    const res = await this.invokeWorker({
      jobId,
      roundNumber: 1,
      executionMode: mode,
      worktreeCwd,
      promptText,
      modelId: this.defaultModel,
      variant: 'high',
      timeoutSeconds,
    });

    return {
      exitCode: res.exitCode,
      stdout: res.responseText,
      stderr: res.rawStderr || '',
      timedOut: res.failureClass === 'TIMEOUT',
      pid: null,
      outputTruncated: res.evidence?.outputTruncated ?? false,
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.processManager.cancelJob(jobId);
  }
}

export const AgyAdapter = AntigravityAdapter;
