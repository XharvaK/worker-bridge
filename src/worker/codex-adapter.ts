import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSafeProcessInvocation, ProcessManager } from '../engine/process-manager.js';
import { logger } from '../utils/logger.js';
import { filterEnv, CODEX_ENV_POLICY } from '../utils/env-filter.js';
import {
  DiscoveredModel,
  ExecutionMode,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
  WorkerSessionIdentity,
} from '../types.js';
import { hashInspectedConfigs, inspectCodexProjectConfig } from './codex-config-guard.js';
import { assertCodexModelSelectable, parseCodexModelCatalog, resolveCodexReasoningProfile } from './codex-model-catalog.js';
import { WorkerAdapter, WorkerAdapterError, WorkerPlatformInfo, analyzeOperationalError } from './worker-adapter.js';

const execFileAsync = promisify(execFile);
const CACHE_MS = 300_000;
const MAX_EVENTS = 128;

export const DEFAULT_CODEX_PATH = 'codex';

export interface JsonlParseResult {
  sessionStatus: 'unique' | 'none' | 'ambiguous' | 'parse_failed';
  sessionId?: string;
  sessionIds: string[];
  text: string;
  toolSummary: Record<string, number>;
  lastMeaningfulAction?: string;
  malformedLines: number;
  totalLines: number;
}

function isDefaultCodexExecutable(executable: string): boolean {
  return executable === DEFAULT_CODEX_PATH;
}

function isWindowsBatchScript(filePath: string): boolean {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(filePath);
}

function sessionIds(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) sessionIds(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['thread_id', 'threadId', 'session_id', 'sessionId'].includes(key) && typeof child === 'string' && child) {
      found.push(child);
    } else if (child && typeof child === 'object') sessionIds(child, found);
  }
  return found;
}

function textValues(value: unknown, result: string[] = []): string[] {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) textValues(item, result);
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['text', 'content'].includes(key) && typeof child === 'string') result.push(child);
    else if (child && typeof child === 'object') textValues(child, result);
  }
  return result;
}

export interface CodexAdapterOptions {
  allowBatchWrappers?: boolean;
}

export class CodexAdapter implements WorkerAdapter {
  readonly platformId = 'codex';
  readonly supportsCrossModelSessionContinuation = false;
  private readonly configuredExecutable: string;
  private readonly executableWasExplicitlyConfigured: boolean;
  private readonly allowBatchWrappers: boolean;
  private discoveredExecutable: string | null = null;
  private discoveredVersion: string | null = null;
  private discoveredAt = 0;
  private processManager: ProcessManager;
  private cachedModels: DiscoveredModel[] | null = null;
  private cacheTimestamp = 0;

  constructor(executable?: string, processManager?: ProcessManager, options?: CodexAdapterOptions) {
    this.executableWasExplicitlyConfigured = executable !== undefined;
    this.configuredExecutable = executable ?? DEFAULT_CODEX_PATH;
    this.processManager = processManager || new ProcessManager();
    this.allowBatchWrappers = options?.allowBatchWrappers ?? false;
  }

  get effectiveExecutable(): string {
    return this.discoveredExecutable ?? this.configuredExecutable;
  }

  getExecutablePath(): string {
    return this.effectiveExecutable;
  }

  private async runDirect(executable: string, args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
    const invocation = getSafeProcessInvocation(executable, args);
    const result = await execFileAsync(invocation.executable, invocation.args, { windowsHide: true, shell: false, timeout });
    return { stdout: String(result.stdout), stderr: String(result.stderr || '') };
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    const configured = this.configuredExecutable;

    if (!this.allowBatchWrappers && this.executableWasExplicitlyConfigured && isWindowsBatchScript(configured)) {
      return {
        platformId: this.platformId,
        displayName: 'Codex CLI',
        installed: false,
        executablePath: configured,
        error: `CLI_MISSING: Codex production executable must be a binary (.exe), not a batch wrapper. Received: "${configured}".`,
      };
    }

    if (this.discoveredExecutable && Date.now() - this.discoveredAt < CACHE_MS) {
      return {
        platformId: this.platformId,
        displayName: 'Codex CLI',
        installed: true,
        version: this.discoveredVersion || '',
        executablePath: this.discoveredExecutable,
      };
    }

    const candidates = [configured];
    if (!this.executableWasExplicitlyConfigured && isDefaultCodexExecutable(configured)) {
      if (process.platform === 'win32') {
        try {
          const where = await this.runDirect('where.exe', ['codex.exe']);
          candidates.push(...where.stdout.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean));
        } catch { /* candidate search is best effort */ }
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        try {
          for (const release of fs.readdirSync(path.join(codexHome, 'packages', 'standalone', 'releases'))) {
            candidates.push(path.join(codexHome, 'packages', 'standalone', 'releases', release, 'bin', 'codex.exe'));
          }
        } catch { /* no standalone releases */ }
      }
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!this.allowBatchWrappers && isWindowsBatchScript(candidate)) continue;
      try {
        const version = (await this.runDirect(candidate, ['--version'])).stdout.trim();
        if (version) {
          this.discoveredExecutable = candidate;
          this.discoveredVersion = version;
          this.discoveredAt = Date.now();
          return { platformId: this.platformId, displayName: 'Codex CLI', installed: true, version, executablePath: candidate };
        }
      } catch { /* try the next verified candidate */ }
    }
    return { platformId: this.platformId, displayName: 'Codex CLI', installed: false, executablePath: configured, error: `CLI_MISSING: Codex executable was not found at "${configured}".` };
  }

  async discoverModels(refresh = false): Promise<DiscoveredModel[]> {
    if (!refresh && this.cachedModels && Date.now() - this.cacheTimestamp < CACHE_MS) return this.cachedModels;
    try {
      const { stdout } = await this.runDirect(this.effectiveExecutable, ['debug', 'models', '--bundled']);
      const parsed = parseCodexModelCatalog(JSON.parse(stdout));
      if (parsed.models.length > 128) {
        logger.warn(`Codex bundled catalog contains ${parsed.models.length} models; truncating to 128.`);
      }
      this.cachedModels = parsed.models.slice(0, 128);
      this.cacheTimestamp = Date.now();
      return this.cachedModels;
    } catch (error) {
      if (error instanceof WorkerAdapterError && error.failureClass === 'MODEL_DISCOVERY_UNAVAILABLE') throw error;
      throw new WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', `Codex bundled model discovery failed: ${String(error)}`);
    }
  }

  async resolveReasoningProfile(modelId: string, requestedStrategy: 'highest-supported' | 'explicit' = 'highest-supported', explicitValue?: string): Promise<string | undefined> {
    const model = (await this.discoverModels()).find((candidate) => candidate.id === modelId);
    if (!model) throw new WorkerAdapterError('MODEL_NOT_FOUND', `Codex model was not discovered: ${modelId}`);
    assertCodexModelSelectable(model);
    const profile = resolveCodexReasoningProfile(model, requestedStrategy, explicitValue);
    if (profile.topology === 'TOPOLOGY_CHANGING') throw new WorkerAdapterError('PERMISSION_BLOCKED', `Codex reasoning topology changes authority: ${profile.value}`);
    return profile.value;
  }

  async probeQuota(_modelId?: string): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN', details: 'Codex quota is authoritative only through Codex-owned execution errors.' };
  }

  async validateExecutionContext(request: WorkerInvocationRequest): Promise<void> {
    const guard = inspectCodexProjectConfig(request.worktreeCwd);
    if (!guard.allowed) throw new WorkerAdapterError('PERMISSION_BLOCKED', guard.reason || 'Codex project configuration is not authorized.');
  }

  private outputPath(request: WorkerInvocationRequest): string {
    const outputDir = path.join(request.worktreeCwd, '.worker-bridge-output');
    fs.mkdirSync(outputDir, { recursive: true });
    return path.join(outputDir, `${request.jobId}-${request.roundNumber}.txt`);
  }

  buildInvocationArgs(request: WorkerInvocationRequest, reasoning: string): string[] {
    const sandbox = request.executionMode === 'READ_ONLY' ? 'read-only' : 'workspace-write';
    const outputPath = this.outputPath(request);
    if (request.sessionId) return ['exec', 'resume', request.sessionId, '--ignore-user-config', '--model', request.modelId, '-c', `model_reasoning_effort="${reasoning}"`, '--json', '--output-last-message', outputPath, '-'];
    return ['exec', '--ignore-user-config', '--cd', request.worktreeCwd, '--model', request.modelId, '-c', `model_reasoning_effort="${reasoning}"`, '--sandbox', sandbox, '--ask-for-approval', 'never', '--json', '--output-last-message', outputPath, '-'];
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    const executable = this.effectiveExecutable;
    if (!this.allowBatchWrappers && isWindowsBatchScript(executable)) {
      throw new WorkerAdapterError('CLI_MISSING', `Codex production executable must be a binary (.exe), not a batch wrapper. Received: "${executable}".`);
    }
    const startedAt = new Date().toISOString();
    const guard = inspectCodexProjectConfig(request.worktreeCwd);
    if (!guard.allowed) {
      throw new WorkerAdapterError('PERMISSION_BLOCKED', guard.reason || 'Codex project configuration is not authorized.');
    }
    const preConfigHash = hashInspectedConfigs(guard.inspectedFiles);

    const reasoning = request.variant
      ? await this.resolveReasoningProfile(request.modelId, 'explicit', request.variant)
      : await this.resolveReasoningProfile(request.modelId);
    if (!reasoning) throw new WorkerAdapterError('REASONING_PROFILE_UNSUPPORTED', `Codex reasoning profile is unavailable for model ${request.modelId}.`);
    if (request.sessionId) {
      const identity = request.sessionIdentity;
      if (!identity || identity.platform !== this.platformId || identity.model !== request.modelId || identity.reasoning !== reasoning || identity.worktreeCwd !== request.worktreeCwd || identity.executionMode !== request.executionMode || identity.sessionId !== request.sessionId) {
        throw new WorkerAdapterError('SESSION_ID_UNAVAILABLE', 'Codex resume identity is missing or does not match the authority envelope.');
      }
    }

    const filteredEnv = filterEnv(CODEX_ENV_POLICY);

    const result = await this.processManager.run(request.jobId, {
      executable,
      args: this.buildInvocationArgs(request, reasoning),
      cwd: request.worktreeCwd,
      stdinText: request.promptText,
      env: filteredEnv,
      timeoutSeconds: request.timeoutSeconds || 900,
    });
    const completedAt = new Date().toISOString();

    const postConfigHash = hashInspectedConfigs(guard.inspectedFiles);
    if (preConfigHash !== null && postConfigHash !== null && preConfigHash !== postConfigHash) {
      return {
        platformId: this.platformId,
        modelId: request.modelId,
        variant: reasoning,
        platformSessionId: undefined,
        exitCode: 1,
        responseText: '',
        artifactsCreated: [],
        toolSummary: {},
        startedAt,
        completedAt,
        failureClass: 'PERMISSION_BLOCKED',
        rawFailureEvidence: 'Codex project configuration was modified during execution (TOCTOU detected).',
        requestPrompt: request.promptText,
        rawStderr: result.stderr,
        evidence: {
          stdout: result.stdout,
          stderr: result.stderr,
          partialResponse: '',
          outputTruncated: result.outputTruncated,
          toolSummary: {},
        },
      };
    }

    const parsed = this.parseJsonl(result.stdout);
    const failure = result.exitCode !== 0 || result.timedOut
      ? analyzeOperationalError(result.exitCode, result.stdout, result.stderr, result.timedOut, startedAt)
      : undefined;

    if (!failure) {
      if (parsed.sessionStatus === 'ambiguous') {
        throw new WorkerAdapterError('SESSION_ID_UNAVAILABLE', 'Codex emitted conflicting session IDs.');
      }
      if (parsed.sessionStatus === 'none' || parsed.sessionStatus === 'parse_failed') {
        throw new WorkerAdapterError('SESSION_ID_UNAVAILABLE', 'Codex emitted no machine-readable session ID.');
      }
    }

    const sessionIdentity: WorkerSessionIdentity = {
      platform: this.platformId,
      model: request.modelId,
      reasoning,
      sessionId: parsed.sessionId,
      worktreeCwd: request.worktreeCwd,
      executionMode: request.executionMode,
    };

    return {
      platformId: this.platformId,
      modelId: request.modelId,
      variant: reasoning,
      platformSessionId: parsed.sessionId,
      exitCode: result.exitCode,
      responseText: parsed.text,
      artifactsCreated: [],
      toolSummary: parsed.toolSummary,
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
        partialResponse: parsed.text,
        outputTruncated: result.outputTruncated,
        toolSummary: parsed.toolSummary,
        sessionId: parsed.sessionId,
        lastMeaningfulAction: parsed.lastMeaningfulAction,
      },
    };
  }

  parseJsonl(stdout: string): JsonlParseResult {
    const ids: string[] = [];
    const texts: string[] = [];
    const toolSummary: Record<string, number> = {};
    let lastMeaningfulAction: string | undefined;
    let malformedLines = 0;
    let totalLines = 0;

    const lines = stdout.split(/\r?\n/).slice(0, MAX_EVENTS);
    for (const line of lines) {
      if (!line.trim()) continue;
      totalLines += 1;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      sessionIds(event, ids);
      if (event && typeof event === 'object' && !Array.isArray(event) && 'type' in event && (event as { type?: unknown }).type === 'tool') {
        const name = event && typeof event === 'object' && 'name' in event && typeof (event as { name?: unknown }).name === 'string' ? (event as { name: string }).name : 'unknown';
        toolSummary[name] = (toolSummary[name] || 0) + 1;
        lastMeaningfulAction = `tool:${name}`;
      }
      texts.push(...textValues(event));
    }

    const uniqueIds = [...new Set(ids)];
    let sessionStatus: JsonlParseResult['sessionStatus'];
    if (uniqueIds.length === 1) {
      sessionStatus = 'unique';
    } else if (uniqueIds.length === 0) {
      sessionStatus = malformedLines > 0 && totalLines === malformedLines ? 'parse_failed' : 'none';
    } else {
      sessionStatus = 'ambiguous';
    }

    return {
      sessionStatus,
      sessionId: uniqueIds.length === 1 ? uniqueIds[0] : undefined,
      sessionIds: uniqueIds,
      text: texts.join('').trim(),
      toolSummary,
      lastMeaningfulAction,
      malformedLines,
      totalLines,
    };
  }

  async cancel(jobId: string): Promise<boolean> { return this.processManager.cancelJob(jobId); }
}
