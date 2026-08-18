import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../config.js';
import { ProcessManager } from './process-manager.js';
import { WorktreeManager } from '../git/worktree.js';
import { verifyBaseSha } from '../git/repo-guard.js';
import { AdapterRegistry } from '../worker/adapter-registry.js';
import { WorkerAdapter, WorkerAdapterError } from '../worker/worker-adapter.js';
import { ModelSelector, ResolvedWorkerSelection } from './model-selector.js';
import {
  TargetAvailabilityLedger,
  TargetAvailabilityStore,
} from './target-availability-ledger.js';
import { buildRecoveryCapsule } from './recovery-capsule.js';
import { roleForJob } from './job-role.js';
import { PlanWorker } from '../worker/plan-worker.js';
import { buildAdapterRegistry } from '../worker/adapter-factory.js';
import { logger } from '../utils/logger.js';
import {
  JobIntent,
  OperationalFailureClass,
  PlanResult,
  RecoveryCapsule,
  SessionPolicy,
  WorkerEvidence,
  WorkerRole,
  WorkerSelection,
  WorkerSessionIdentity,
} from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Transport-neutral READ_ONLY execution request. Transports (mailbox or durable
 * IPC) supply the job identity, goal, and selection preferences; the kernel
 * owns role derivation, target selection, availability, fallback, PlanWorker
 * invocation, and read-only verification.
 */
export interface ReadOnlyExecutionRequest {
  jobId: string;
  projectId: string;
  projectPath: string;
  intent: JobIntent;
  goal: string;
  role?: WorkerRole;
  baseSha?: string;
  timeoutSeconds?: number;
  workerSelection?: WorkerSelection;
  sessionPolicy?: SessionPolicy;
  previousSession?: WorkerSessionIdentity;
  recoveryCapsule?: RecoveryCapsule;
  round?: number;
  revision?: number;
  excludedPlatforms?: Set<string> | string[];
}

export interface ReadOnlyResolvedExecution {
  role: WorkerRole;
  selection: ResolvedWorkerSelection;
  sessionIdToUse?: string;
  sessionIdentityToUse?: WorkerSessionIdentity;
  baseSha: string;
}

export interface ReadOnlyExecutionOutcome {
  jobId: string;
  role: WorkerRole;
  terminalState: 'WORKER_RETURNED' | 'FAILED';
  selectedTarget: ResolvedWorkerSelection;
  attempts: number;
  planResult: PlanResult & { targetId: string };
  recoveryCapsule?: RecoveryCapsule;
  verification: string;
}

/**
 * Raised by resolve() when no worker can be invoked (selection failure, invalid
 * base SHA, missing goal/CLI, unavailable targets). Carries execution evidence
 * so either transport can publish/store the blocked state without re-deriving
 * it.
 */
export class ReadOnlySelectionBlocked extends Error {
  readonly failureClass: OperationalFailureClass;
  readonly capsule?: RecoveryCapsule;

  constructor(failureClass: OperationalFailureClass, message: string, capsule?: RecoveryCapsule) {
    super(message);
    this.name = 'ReadOnlySelectionBlocked';
    this.failureClass = failureClass;
    this.capsule = capsule;
  }
}

export interface ReadOnlyKernelDependencies {
  adapterRegistry?: AdapterRegistry;
  availability?: TargetAvailabilityStore;
  processManager?: ProcessManager;
  worktreeManager?: WorktreeManager;
  planWorker?: PlanWorker;
  modelSelector?: ModelSelector;
}

export class ReadOnlyExecutionKernel {
  private readonly configManager: ConfigManager;
  private readonly availability: TargetAvailabilityStore;
  private readonly processManager: ProcessManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly modelSelector: ModelSelector;
  private readonly planWorker: PlanWorker;

  constructor(configManager: ConfigManager, deps?: ReadOnlyKernelDependencies) {
    this.configManager = configManager;
    this.availability = deps?.availability || new TargetAvailabilityLedger();
    this.processManager = deps?.processManager || new ProcessManager();
    this.worktreeManager =
      deps?.worktreeManager || new WorktreeManager(configManager.getConfig().workerRootDir);
    this.adapterRegistry =
      deps?.adapterRegistry || buildAdapterRegistry(configManager.getConfig(), this.processManager);
    this.modelSelector =
      deps?.modelSelector ||
      new ModelSelector(this.adapterRegistry, configManager.getConfig(), this.availability);
    const defaultAdapter = this.adapterRegistry.getAll()[0];
    this.planWorker =
      deps?.planWorker || new PlanWorker(this.worktreeManager, defaultAdapter);
  }

  getModelSelector(): ModelSelector {
    return this.modelSelector;
  }

  getAdapterRegistry(): AdapterRegistry {
    return this.adapterRegistry;
  }

  getProcessManager(): ProcessManager {
    return this.processManager;
  }

  private allowFallbackFor(req: ReadOnlyExecutionRequest): boolean {
    const selection = req.workerSelection;
    if (selection?.allowFallback === false) return false;

    const requestedModel = selection?.model?.trim().toLowerCase();
    const explicitTarget = Boolean(
      selection?.targetId || (requestedModel && !['auto', 'your call'].includes(requestedModel))
    );
    if (explicitTarget) return selection?.fallbackSelection !== undefined;
    if (selection?.allowFallback === true) return true;

    const policy = this.configManager.getConfig().selectionPolicy;
    return (
      policy?.allowFallbackByDefault === true ||
      !requestedModel ||
      ['auto', 'your call'].includes(requestedModel)
    );
  }

  private recordTargetFailure(
    selection: ResolvedWorkerSelection,
    failureClass: PlanResult['failureClass'],
    retryAt?: string,
    rawEvidence?: string
  ): void {
    if (!failureClass) return;
    const target = this.modelSelector.getTargetConfig(selection.targetId);
    if (!target) return;
    this.availability.recordFailure(
      target,
      failureClass,
      new Date().toISOString(),
      retryAt,
      rawEvidence,
      'worker_result'
    );
  }

  private buildPreInvocationFailureCapsule(
    req: ReadOnlyExecutionRequest,
    role: WorkerRole,
    failureClass: OperationalFailureClass,
    message: string
  ): RecoveryCapsule {
    return buildRecoveryCapsule({
      contract: {
        jobId: req.jobId,
        round: req.round || 1,
        revision: req.revision || 0,
        role,
        originalGoal: req.goal,
        acceptedPlan: '',
        solReview: '',
        baseSha: req.baseSha || 'resolved-at-execution',
        executionMode: 'READ_ONLY',
        executionConstraints: ['No worker invocation occurred after the bridge failed closed.'],
      },
      sourceWorker: {
        targetId: req.workerSelection?.targetId,
        platform: req.workerSelection?.platform || 'unknown',
        model: req.workerSelection?.model || 'unknown',
        reasoning: typeof req.workerSelection?.reasoning === 'object'
          ? req.workerSelection.reasoning.value
          : req.workerSelection?.reasoning,
        sessionId: req.previousSession?.sessionId,
        failureClass,
      },
      capturedHistory: {
        stdout: '',
        stderr: message,
        partialResponse: '',
        outputTruncated: false,
        sessionId: req.previousSession?.sessionId,
      },
      currentState: {
        worktreePath: this.worktreeManager.getPlanWorktreePath(req.projectId, req.jobId),
        baseSha: req.baseSha || 'resolved-at-execution',
        headSha: req.baseSha,
        gitStatus: 'not-captured',
        gitDiff: '',
        gitDiffStat: '',
        diffCheck: 'not-run',
        filesChanged: [],
        bridgeVerification: { preInvocation: 'failed' },
        incompleteOperations: ['worker invocation was refused before execution'],
      },
      recoveryDirective: {
        provenComplete: ['the bridge preserved the exact requested failure identity'],
        appearsIncomplete: ['worker invocation'],
        knownFailures: [failureClass || 'PROCESS_FAILED'],
        remainingWork: ['resolve the exact target/session/authority identity explicitly'],
        mustNotRepeatBlindly: ['substitute a different target, model, reasoning profile, or session'],
        instruction: 'PRESERVE EXACT FAILURE EVIDENCE. DO NOT SILENTLY SUBSTITUTE A WORKER.',
      },
    });
  }

  private buildPlanRecoveryCapsule(
    req: ReadOnlyExecutionRequest,
    role: WorkerRole,
    selection: ResolvedWorkerSelection,
    result: PlanResult,
    originalGoal: string
  ): RecoveryCapsule {
    const evidence: WorkerEvidence = result.evidence || {
      stdout: result.planText,
      stderr: result.error || '',
      partialResponse: result.planText,
      outputTruncated: false,
      sessionId: result.sessionId,
    };
    return buildRecoveryCapsule({
      contract: {
        jobId: req.jobId,
        round: req.round || 1,
        revision: req.revision || 0,
        role,
        originalGoal,
        acceptedPlan: '',
        solReview: '',
        baseSha: req.baseSha || 'resolved-at-execution',
        executionMode: 'READ_ONLY',
        executionConstraints: [
          'READ_ONLY mode must not modify source files.',
          'Use a fresh destination session for fallback.',
        ],
      },
      sourceWorker: {
        targetId: selection.targetId,
        platform: result.platform,
        model: result.model,
        reasoning: result.sessionIdentity?.reasoning || result.variant,
        sessionId: result.sessionIdentity?.sessionId || result.sessionId,
        requestPrompt: '',
        failureClass: result.failureClass,
        retryAt: result.retryAt,
      },
      capturedHistory: evidence,
      currentState: {
        worktreePath: result.worktreePath || 'not-preserved-read-only-worktree',
        baseSha: req.baseSha || 'resolved-at-execution',
        headSha: req.baseSha,
        gitStatus: result.mutatedFiles.join('\n'),
        gitDiff: '',
        gitDiffStat: '',
        diffCheck: 'not-run',
        filesChanged: result.mutatedFiles,
        bridgeVerification: { readOnly: result.clean ? 'passed' : 'failed' },
        incompleteOperations: ['read-only worker attempt did not complete'],
      },
      recoveryDirective: {
        provenComplete: ['target selection and bounded worker evidence were captured'],
        appearsIncomplete: ['requested read-only investigation and plan'],
        knownFailures: [result.failureClass || 'PROCESS_FAILED'],
        remainingWork: ['retry the role with the next eligible target'],
        mustNotRepeatBlindly: ['retry the failed target before its authoritative retryAt'],
        instruction: 'START A FRESH READ-ONLY RECOVERY ATTEMPT USING THIS CAPSULE.',
      },
    });
  }

  /**
   * Phase 1: derive role, validate the trusted project/base SHA, and resolve the
   * exact worker selection (including CONTINUE session policy). Throws
   * ReadOnlySelectionBlocked when no worker may be invoked; transports publish
   * the blocked state with the carried evidence.
   */
  async resolve(req: ReadOnlyExecutionRequest): Promise<ReadOnlyResolvedExecution> {
    const role = req.role || roleForJob(req.intent);
    if (!fs.existsSync(req.projectPath)) {
      throw new ReadOnlySelectionBlocked(
        'PROCESS_FAILED',
        `PROJECT_NOT_FOUND: Directory "${req.projectPath}" does not exist.`,
        this.buildPreInvocationFailureCapsule(req, role, 'PROCESS_FAILED', `PROJECT_NOT_FOUND: Directory "${req.projectPath}" does not exist.`)
      );
    }

    let baseSha = req.baseSha;
    if (!baseSha) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', req.projectPath, 'rev-parse', 'HEAD'], {
          windowsHide: true,
        });
        baseSha = stdout.trim();
      } catch (err) {
        const message = `INVALID_BASE_SHA: Could not resolve HEAD in "${req.projectPath}": ${String(err)}`;
        throw new ReadOnlySelectionBlocked('PROCESS_FAILED', message, this.buildPreInvocationFailureCapsule(req, role, 'PROCESS_FAILED', message));
      }
    } else {
      const shaValid = await verifyBaseSha(req.projectPath, baseSha);
      if (!shaValid.valid) {
        throw new ReadOnlySelectionBlocked(
          'PROCESS_FAILED',
          `INVALID_BASE_SHA: ${shaValid.error}`,
          this.buildPreInvocationFailureCapsule(req, role, 'PROCESS_FAILED', `INVALID_BASE_SHA: ${shaValid.error}`)
        );
      }
    }

    const automaticReviewerAvoidance =
      role === 'REVIEWER' && this.configManager.getConfig().selectionPolicy?.reviewerPreferDifferentTarget
        ? req.workerSelection?.avoidTargetId || req.previousSession?.targetId
        : req.workerSelection?.avoidTargetId;

    let resolvedWorker: ResolvedWorkerSelection;
    try {
      const requestedSelection =
        req.sessionPolicy === 'CONTINUE' &&
        req.previousSession?.targetId &&
        (!req.workerSelection?.targetId &&
          (!req.workerSelection?.model ||
            ['auto', 'your call'].includes(req.workerSelection.model.toLowerCase())))
          ? {
              targetId: req.previousSession.targetId,
              platform: req.previousSession.platform,
              model: req.previousSession.model,
              reasoning: req.previousSession.reasoning
                ? { strategy: 'explicit' as const, value: req.previousSession.reasoning }
                : undefined,
            }
          : req.sessionPolicy === 'CONTINUE' &&
              req.previousSession?.targetId &&
              req.workerSelection?.targetId === req.previousSession.targetId &&
              !req.workerSelection.model &&
              !!req.previousSession.model
            ? {
                ...req.workerSelection,
                platform: req.workerSelection.platform || req.previousSession.platform,
                model: req.previousSession.model,
                reasoning: req.workerSelection.reasoning || (req.previousSession.reasoning
                  ? { strategy: 'explicit' as const, value: req.previousSession.reasoning }
                  : undefined),
              }
            : req.workerSelection;
      if (
        requestedSelection?.targetId &&
        req.sessionPolicy === 'CONTINUE' &&
        req.previousSession?.targetId === requestedSelection.targetId
      ) {
        if (!this.availability.isEligible(requestedSelection.targetId)) {
          throw new WorkerAdapterError(
            'MODEL_UNAVAILABLE',
            `MODEL_SELECTION_ERROR: CONTINUE target "${requestedSelection.targetId}" is unavailable.`
          );
        }
      }
      resolvedWorker = await this.modelSelector.resolveSelection(
        requestedSelection,
        role,
        new Set<string>(),
        automaticReviewerAvoidance,
        new Date(),
        req.excludedPlatforms
      );
    } catch (err: any) {
      if (err instanceof WorkerAdapterError) {
        throw new ReadOnlySelectionBlocked(
          err.failureClass,
          err.message,
          this.buildPreInvocationFailureCapsule(req, role, err.failureClass, err.message)
        );
      }
      throw new ReadOnlySelectionBlocked(
        'PROCESS_FAILED',
        err.message || String(err),
        this.buildPreInvocationFailureCapsule(req, role, 'PROCESS_FAILED', err.message || String(err))
      );
    }

    let sessionIdToUse: string | undefined;
    let sessionIdentityToUse: WorkerSessionIdentity | undefined;
    const prev = req.previousSession;

    if (req.sessionPolicy === 'CONTINUE' && !prev?.sessionId) {
      throw new ReadOnlySelectionBlocked(
        'SESSION_ID_UNAVAILABLE',
        'SESSION_ID_UNAVAILABLE: CONTINUE requires an exact persisted platform session ID; no worker was invoked.',
        this.buildPreInvocationFailureCapsule(req, role, 'SESSION_ID_UNAVAILABLE', 'SESSION_ID_UNAVAILABLE: CONTINUE requires an exact persisted platform session ID; no worker was invoked.')
      );
    }

    if (
      req.sessionPolicy === 'CONTINUE' &&
      prev?.sessionId &&
      prev &&
      this.modelSelector.canContinueSession(prev, resolvedWorker, 'READ_ONLY', '')
    ) {
      sessionIdToUse = prev.sessionId;
      sessionIdentityToUse = prev;
      logger.info(`Continuing existing ${resolvedWorker.platform} session: ${sessionIdToUse}`);
    } else {
      logger.info(`Starting FRESH ${resolvedWorker.platform} session for job ${req.jobId}`);
    }

    return {
      role,
      selection: resolvedWorker,
      sessionIdToUse,
      sessionIdentityToUse,
      baseSha,
    };
  }

  /**
   * Phase 2: execute the resolved worker through PlanWorker with bounded
   * fallback, recording availability evidence and building recovery capsules.
   * Transports persist the returned outcome according to their own storage.
   */
  async execute(
    req: ReadOnlyExecutionRequest,
    resolved: ReadOnlyResolvedExecution
  ): Promise<ReadOnlyExecutionOutcome> {
    const adapter = this.adapterRegistry.get(resolved.selection.platform);
    if (!adapter) {
      throw new Error(`Adapter for platform "${resolved.selection.platform}" not found`);
    }

    let currentWorkerSelection = resolved.selection;
    let currentAdapter = adapter;
    const runPlan = async (
      selection: ResolvedWorkerSelection,
      planAdapter: WorkerAdapter,
      sessionIdToUse?: string,
      sessionIdentityToUse?: WorkerSessionIdentity
    ): Promise<PlanResult & { targetId: string }> => {
      const raw = await this.planWorker.execute(
        req.jobId,
        req.projectId,
        req.projectPath,
        resolved.baseSha,
        req.goal,
        req.timeoutSeconds,
        planAdapter,
        selection.modelId,
        selection.variant,
        sessionIdToUse,
        req.round || 1,
        req.recoveryCapsule,
        selection.targetId,
        sessionIdentityToUse
      );
      return { ...raw, targetId: selection.targetId };
    };
    let planRes = await runPlan(currentWorkerSelection, currentAdapter, resolved.sessionIdToUse, resolved.sessionIdentityToUse);

    const allowFallback = this.allowFallbackFor(req);
    const failedTargetIds = new Set<string>();
    let attempts = 0;
    const maxFallbackAttempts = this.configManager.getConfig().selectionPolicy?.maxFallbackAttempts ?? 3;

    while (
      (planRes.failureClass === 'QUOTA_EXHAUSTED' || planRes.failureClass === 'RATE_LIMITED') &&
      allowFallback &&
      attempts < maxFallbackAttempts
    ) {
      attempts++;
      failedTargetIds.add(currentWorkerSelection.targetId);
      this.recordTargetFailure(
        currentWorkerSelection,
        planRes.failureClass,
        planRes.retryAt,
        planRes.rawFailureEvidence
      );
      logger.warn(
        `Worker ${currentWorkerSelection.targetId} failed with ${planRes.failureClass}. Attempting fallback (attempt ${attempts}/${maxFallbackAttempts})...`
      );
      try {
        currentWorkerSelection = await this.modelSelector.getNextFallback(
          currentWorkerSelection,
          resolved.role,
          {
            failedTargetIds,
            authorizedFallback: req.workerSelection?.fallbackSelection,
            excludedPlatforms: req.excludedPlatforms,
          }
        );
        currentAdapter = this.adapterRegistry.get(currentWorkerSelection.platform)!;
        planRes = await runPlan(currentWorkerSelection, currentAdapter);
      } catch {
        break;
      }
    }

    if (planRes.clean && planRes.exitCode === 0) {
      this.availability.recordSuccess(
        currentWorkerSelection.targetId,
        this.modelSelector.getTargetConfig(currentWorkerSelection.targetId)
      );
      return {
        jobId: req.jobId,
        role: resolved.role,
        terminalState: 'WORKER_RETURNED',
        selectedTarget: currentWorkerSelection,
        attempts,
        planResult: planRes,
        recoveryCapsule:
          planRes.recoveryEvidence ||
          this.buildPlanRecoveryCapsule(req, resolved.role, currentWorkerSelection, planRes, req.goal),
        verification:
          'READ_ONLY verified: isolated worktree remained clean; no source mutations detected.',
      };
    }

    const failedOutcome: ReadOnlyExecutionOutcome = {
      jobId: req.jobId,
      role: resolved.role,
      terminalState: 'FAILED',
      selectedTarget: currentWorkerSelection,
      attempts,
      planResult: planRes,
      verification: planRes.clean
        ? `Worker process failed (${planRes.failureClass || 'PROCESS_FAILED'}).`
        : 'READ_ONLY violation: worker modified source files; mutations rejected and worktree discarded.',
    };
    if (planRes.failureClass === 'QUOTA_EXHAUSTED' || planRes.failureClass === 'RATE_LIMITED') {
      this.recordTargetFailure(
        currentWorkerSelection,
        planRes.failureClass,
        planRes.retryAt,
        planRes.rawFailureEvidence
      );
      failedOutcome.recoveryCapsule =
        planRes.recoveryEvidence ||
        this.buildPlanRecoveryCapsule(req, resolved.role, currentWorkerSelection, planRes, req.goal);
    }
    return failedOutcome;
  }

  /**
   * Cancel an active worker execution through the single shared ProcessManager.
   */
  async cancelActiveExecution(jobId: string): Promise<boolean> {
    return this.processManager.cancelJob(jobId);
  }
}