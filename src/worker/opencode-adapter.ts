import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { getSafeProcessInvocation, ProcessManager } from '../engine/process-manager.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../types.js';
import { WorkerAdapter, WorkerPlatformInfo, analyzeOperationalError } from './worker-adapter.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_OPENCODE_PATH = 'opencode';
export const DEFAULT_OPENCODE_MODEL = 'opencode/deepseek-v4-flash-free';

export class OpenCodeAdapter implements WorkerAdapter {
  readonly platformId = 'opencode';
  private opencodeExecutable: string;
  private defaultModel: string;
  private processManager: ProcessManager;
  private cachedModels: DiscoveredModel[] | null = null;
  private cacheTimestamp = 0;

  constructor(
    opencodeExecutable = DEFAULT_OPENCODE_PATH,
    defaultModel = DEFAULT_OPENCODE_MODEL,
    processManager?: ProcessManager
  ) {
    this.opencodeExecutable = opencodeExecutable;
    this.defaultModel = defaultModel;
    this.processManager = processManager || new ProcessManager();
  }

  getExecutablePath(): string {
    return this.opencodeExecutable;
  }

  getModel(): string {
    return this.defaultModel;
  }

  getJobLogFilePath(jobId: string): string {
    const logsDir = path.join(USER_BRIDGE_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${jobId}-opencode.log`);
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    const tryRunVersion = async (exe: string): Promise<string | undefined> => {
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

    const directVersion = await tryRunVersion(this.opencodeExecutable);
    if (directVersion) {
      return {
        platformId: this.platformId,
        displayName: 'OpenCode CLI',
        installed: true,
        version: directVersion,
        executablePath: this.opencodeExecutable,
      };
    }

    if (process.platform === 'win32') {
      try {
        const { stdout: whereOut } = await execFileAsync('where.exe', ['opencode.cmd', 'opencode'], {
          windowsHide: true,
        });
        const foundPath = whereOut.split(/\r?\n/)[0].trim();
        if (foundPath) {
          this.opencodeExecutable = foundPath;
          const ver = (await tryRunVersion(foundPath)) || '1.18.15';
          return {
            platformId: this.platformId,
            displayName: 'OpenCode CLI',
            installed: true,
            version: ver,
            executablePath: foundPath,
          };
        }
      } catch {}
    }

    return {
      platformId: this.platformId,
      displayName: 'OpenCode CLI',
      installed: false,
      executablePath: this.opencodeExecutable,
      error: `OPENCODE_CLI_MISSING: OpenCode executable was not found at "${this.opencodeExecutable}".`,
    };
  }

  async discoverModels(refresh = false): Promise<DiscoveredModel[]> {
    const now = Date.now();
    if (!refresh && this.cachedModels && now - this.cacheTimestamp < 300000) {
      return this.cachedModels;
    }

    try {
      await this.inspectEnvironment();
      const invocation = getSafeProcessInvocation(this.opencodeExecutable, ['models', '--verbose']);
      const { stdout } = await execFileAsync(invocation.executable, invocation.args, {
        windowsHide: true,
        shell: false,
        timeout: 15000,
      });

      const models: DiscoveredModel[] = [];
      const lines = stdout.split(/\r?\n/);

      let currentModelId = '';
      let jsonBuffer = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        // Model ID line format: provider/model-id or model-id
        if (!line.startsWith('{') && !line.startsWith(' ') && line.includes('/')) {
          if (currentModelId && jsonBuffer.trim()) {
            this.parseModelJsonBuffer(currentModelId, jsonBuffer, models);
          }
          currentModelId = line.trim();
          jsonBuffer = '';
        } else if (currentModelId) {
          jsonBuffer += line + '\n';
        }
      }

      if (currentModelId && jsonBuffer.trim()) {
        this.parseModelJsonBuffer(currentModelId, jsonBuffer, models);
      }

      if (models.length > 0) {
        this.cachedModels = models;
        this.cacheTimestamp = now;
        return models;
      }
    } catch (err) {
      logger.debug(`Could not dynamically fetch OpenCode models via CLI: ${String(err)}`);
    }

    // Fallback baseline discovered models
    const fallbackModels: DiscoveredModel[] = [
      { id: 'opencode/deepseek-v4-flash-free', displayName: 'DeepSeek V4 Flash Free', variants: ['low', 'high', 'max'], highestVariant: 'max' },
      { id: 'opencode/hy3-free', displayName: 'Hy3 Free', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'opencode/laguna-s-2.1-free', displayName: 'Laguna S 2.1 Free', variants: ['low', 'medium', 'high'], highestVariant: 'high' },
      { id: 'opencode/nemotron-3-ultra-free', displayName: 'Nemotron 3 Ultra Free', variants: [], highestVariant: undefined },
      { id: 'opencode/nemotron-3.5-lightning-free', displayName: 'Nemotron 3.5 Lightning Free', variants: [], highestVariant: undefined },
      { id: 'opencode/big-pickle', displayName: 'Big Pickle', variants: [], highestVariant: undefined },
      { id: 'opencode/mimo-v2.5-free', displayName: 'MiMo V2.5 Free', variants: [], highestVariant: undefined },
    ];
    this.cachedModels = fallbackModels;
    this.cacheTimestamp = now;
    return fallbackModels;
  }

  private parseModelJsonBuffer(modelId: string, jsonBuffer: string, list: DiscoveredModel[]) {
    try {
      const parsed = JSON.parse(jsonBuffer.trim());
      const variantsObj = parsed.variants || {};
      const variants = Object.keys(variantsObj);

      let highestVariant: string | undefined;
      if (variants.includes('max')) {
        highestVariant = 'max';
      } else if (variants.includes('high')) {
        highestVariant = 'high';
      } else if (variants.includes('medium')) {
        highestVariant = 'medium';
      } else if (variants.length > 0) {
        highestVariant = variants[variants.length - 1];
      }

      list.push({
        id: modelId,
        displayName: parsed.name || modelId,
        family: parsed.family,
        variants,
        highestVariant,
        contextLimit: parsed.limit?.context,
      });
    } catch {
      list.push({
        id: modelId,
        displayName: modelId,
        variants: [],
        highestVariant: undefined,
      });
    }
  }

  async resolveReasoningProfile(
    modelId: string,
    requestedStrategy: 'highest-supported' | 'explicit' = 'highest-supported',
    explicitValue?: string
  ): Promise<string | undefined> {
    if (requestedStrategy === 'explicit' && explicitValue) {
      return explicitValue;
    }

    const models = await this.discoverModels();
    const model = models.find((m) => m.id === modelId || m.id.endsWith(`/${modelId}`));
    return model?.highestVariant;
  }

  async probeQuota(_modelId?: string): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN', details: 'OpenCode quota is provider-specific and not available via universal pre-run query' };
  }

  buildInvocationArgs(
    promptText: string,
    worktreeCwd: string,
    modelId: string,
    variant?: string,
    sessionId?: string
  ): string[] {
    const args: string[] = ['run'];

    // Message prompt
    args.push(promptText);

    // Isolated directory
    args.push('--dir', worktreeCwd);

    // Selected model
    args.push('-m', modelId || this.defaultModel);

    // Variant / reasoning effort if supported
    if (variant) {
      args.push('--variant', variant);
    }

    // Session continuation
    if (sessionId) {
      args.push('-s', sessionId);
    }

    // Structured output & headless auto approvals
    args.push('--format', 'json');
    args.push('--auto');

    return args;
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    const startedAt = new Date().toISOString();
    const model = request.modelId || this.defaultModel;
    const variant = request.variant;
    const logFilePath = this.getJobLogFilePath(request.jobId);

    await this.inspectEnvironment();

    fs.writeFileSync(
      logFilePath,
      `=== Execution Started: ${startedAt} ===\nPlatform: ${this.platformId}\nExecutionMode: ${request.executionMode}\nModel: ${model}\nVariant: ${variant || 'none'}\nWorktree: ${request.worktreeCwd}\nSessionId: ${request.sessionId || 'none'}\n\n`,
      'utf8'
    );

    const args = this.buildInvocationArgs(
      request.promptText,
      request.worktreeCwd,
      model,
      variant,
      request.sessionId
    );

    logger.info(
      `Invoking OpenCode worker for job ${request.jobId} (Model: ${model}, Variant: ${variant || 'none'}) in ${request.worktreeCwd}`
    );

    const result = await this.processManager.run(request.jobId, {
      executable: this.opencodeExecutable,
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

    const parsed = this.parseJsonStreamOutput(result.stdout);

    return {
      platformId: this.platformId,
      modelId: model,
      variant,
      platformSessionId: parsed.sessionId,
      exitCode: result.exitCode,
      responseText: parsed.text || result.stdout.trim(),
      artifactsCreated: parsed.artifactsCreated,
      toolSummary: parsed.toolSummary,
      startedAt,
      completedAt,
      failureClass: failure?.failureClass,
      retryAt: failure?.retryAt,
      rawFailureEvidence: failure?.rawEvidence,
      requestPrompt: request.promptText,
      evidence: {
        stdout: result.stdout,
        stderr: result.stderr,
        partialResponse: parsed.text || result.stdout.trim(),
        outputTruncated: result.outputTruncated,
        toolSummary: parsed.toolSummary,
        sessionId: parsed.sessionId,
        lastMeaningfulAction: parsed.lastMeaningfulAction,
      },
      rawStderr: result.stderr,
    };
  }

  private parseJsonStreamOutput(stdout: string): {
    text: string;
    sessionId?: string;
    artifactsCreated: string[];
    toolSummary: Record<string, number>;
    lastMeaningfulAction?: string;
  } {
    let accumulatedText = '';
    let sessionId: string | undefined;
    const artifactsCreated: string[] = [];
    const toolSummary: Record<string, number> = {};
    let lastMeaningfulAction: string | undefined;

    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      try {
        const evt = JSON.parse(trimmed);

        if (evt.sessionID || evt.sessionId || evt.session?.id) {
          sessionId = evt.sessionID || evt.sessionId || evt.session?.id;
        }

        if (evt.type === 'tool' || evt.tool) {
          const toolName = evt.tool || evt.name || 'unknown';
          toolSummary[toolName] = (toolSummary[toolName] || 0) + 1;
          lastMeaningfulAction = `tool:${toolName}`;
        }

        if (typeof evt.content === 'string') {
          accumulatedText += evt.content;
          lastMeaningfulAction = evt.content.trim() || lastMeaningfulAction;
        } else if (typeof evt.text === 'string') {
          accumulatedText += evt.text;
          lastMeaningfulAction = evt.text.trim() || lastMeaningfulAction;
        } else if (evt.message?.content && typeof evt.message.content === 'string') {
          accumulatedText += evt.message.content;
          lastMeaningfulAction = evt.message.content.trim() || lastMeaningfulAction;
        }
      } catch {
        // Non-JSON line
      }
    }

    if (!accumulatedText.trim()) {
      accumulatedText = stdout.trim();
    }

    return {
      text: accumulatedText.trim(),
      sessionId,
      artifactsCreated,
      toolSummary,
      lastMeaningfulAction,
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.processManager.cancelJob(jobId);
  }
}
