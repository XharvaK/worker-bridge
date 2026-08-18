import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../config.js';
import { Ledger } from './ledger.js';
import { ProcessManager } from './process-manager.js';
import { MailboxSyncer } from '../mailbox/syncer.js';
import { MailboxTransport } from '../mailbox/transport.js';
import { WorktreeManager } from '../git/worktree.js';
import { verifyBaseSha } from '../git/repo-guard.js';
import { AdapterRegistry } from '../worker/adapter-registry.js';
import { AntigravityAdapter } from '../worker/agy-adapter.js';
import { OpenCodeAdapter } from '../worker/opencode-adapter.js';
import { CodexAdapter } from '../worker/codex-adapter.js';
import { CursorAdapter } from '../worker/cursor-adapter.js';
import { FreebuffAdapter } from '../worker/freebuff-adapter.js';
import { WorkerAdapterError } from '../worker/worker-adapter.js';
import { ModelSelector, ResolvedWorkerSelection } from './model-selector.js';
import { TargetAvailabilityLedger } from './target-availability-ledger.js';
import {
  buildRecoveryCapsule,
  parseRecoveryCapsule,
  RECOVERY_CAPSULE_MAX_BYTES,
} from './recovery-capsule.js';
import { roleForJob } from './job-role.js';
import { PlanWorker } from '../worker/plan-worker.js';
import { ImplementWorker } from '../worker/implement-worker.js';
import { sendWindowsNotification } from '../utils/notifier.js';
import { logger } from '../utils/logger.js';
import {
  JobStatus,
  ExecutionMode,
  ImplementResult,
  PlanResult,
  RecoveryCapsule,
  WorkerEvidence,
  WorkerRole,
  WorkerSessionIdentity,
  WorkJob,
} from '../types.js';

const execFileAsync = promisify(execFile);

export class Orchestrator {
  private configManager: ConfigManager;
  private ledger: Ledger;
  private processManager: ProcessManager;
  private mailboxSyncer: MailboxSyncer;
  private mailboxTransport: MailboxTransport;
  private worktreeManager: WorktreeManager;
  private adapterRegistry: AdapterRegistry;
  private modelSelector: ModelSelector;
  private availability: TargetAvailabilityLedger;
  private planWorker: PlanWorker;
  private implementWorker: ImplementWorker;
  private isRunning = false;

  constructor(
    configManager: ConfigManager,
    customLedger?: Ledger,
    customRegistry?: AdapterRegistry,
    customAvailability?: TargetAvailabilityLedger
  ) {
    this.configManager = configManager;
    const cfg = configManager.getConfig();

    this.ledger = customLedger || new Ledger();
    this.availability = customAvailability || new TargetAvailabilityLedger();
    this.processManager = new ProcessManager();
    this.mailboxSyncer = new MailboxSyncer(cfg.mailboxRepoPath);
    this.mailboxTransport = new MailboxTransport(cfg.mailboxRepoPath, cfg.mailboxRemote, 'main');
    this.worktreeManager = new WorktreeManager(cfg.workerRootDir);

    this.adapterRegistry = customRegistry || new AdapterRegistry();
    if (!customRegistry) {
      const agyExe = cfg.platforms?.antigravity?.executable || cfg.agyExecutable;
      const agyModel = cfg.platforms?.antigravity?.defaultModel || cfg.workerModel;
      const opencodeExe = cfg.platforms?.opencode?.executable || 'opencode';
      const opencodeModel = cfg.platforms?.opencode?.defaultModel || 'opencode/deepseek-v4-flash-free';
      const codexExe = cfg.platforms?.codex?.executable || 'codex';
      const cursorExe = cfg.platforms?.['cursor-cli']?.executable || cfg.platforms?.cursor?.executable || 'cursor';
      const cursorModel = cfg.platforms?.['cursor-cli']?.defaultModel || cfg.platforms?.cursor?.defaultModel || 'grok-4.6';
      const freebuffExe = cfg.platforms?.freebuff?.executable || 'freebuff';

      this.adapterRegistry.register(new AntigravityAdapter(agyExe, agyModel, this.processManager));
      this.adapterRegistry.register(new OpenCodeAdapter(opencodeExe, opencodeModel, this.processManager));
      this.adapterRegistry.register(new CodexAdapter(codexExe, this.processManager));
      this.adapterRegistry.register(new CursorAdapter(cursorExe, cursorModel, this.processManager));
      this.adapterRegistry.register(new FreebuffAdapter(freebuffExe, this.processManager));
    }

    this.modelSelector = new ModelSelector(this.adapterRegistry, cfg, this.availability);
    const defaultAdapter = this.adapterRegistry.get('antigravity') || this.adapterRegistry.getAll()[0];
    this.planWorker = new PlanWorker(this.worktreeManager, defaultAdapter);
    this.implementWorker = new ImplementWorker(this.worktreeManager, defaultAdapter);
  }

  getAdapterRegistry(): AdapterRegistry {
    return this.adapterRegistry;
  }

  getModelSelector(): ModelSelector {
    return this.modelSelector;
  }

  private roleForSpec(spec: WorkJob): WorkerRole {
    return spec.recovery?.enabled ? 'WORKER' : spec.role || roleForJob(spec.intent);
  }

  private allowFallbackFor(spec: WorkJob): boolean {
    const selection = spec.workerSelection;
    if (selection?.allowFallback === false) return false;

    const requestedModel = selection?.model?.trim().toLowerCase();
    const explicitTarget = Boolean(
      selection?.targetId || (requestedModel && !['auto', 'your call'].includes(requestedModel))
    );
    if (explicitTarget) return selection?.fallbackSelection !== undefined;
    if (selection?.allowFallback === true) return true;

    const policy = this.configManager.getConfig().selectionPolicy;
    return policy?.allowFallbackByDefault === true || !requestedModel || ['auto', 'your call'].includes(requestedModel);
  }

  private async readRecoveryCapsule(spec: WorkJob): Promise<RecoveryCapsule | undefined> {
    if (!spec.recovery?.enabled) return undefined;
    try {
      const jobDir = path.resolve(this.mailboxSyncer.getJobDir(spec.jobId));
      const jobRoot = fs.realpathSync(jobDir);
      const readSafeCapsule = (requestedPath: string): RecoveryCapsule | undefined => {
        const candidate = path.isAbsolute(requestedPath)
          ? path.resolve(requestedPath)
          : path.resolve(jobRoot, requestedPath);
        const relative = path.relative(jobRoot, candidate);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Recovery capsule path must remain inside the job mailbox directory.');
        }
        if (!fs.existsSync(candidate)) return undefined;
        const realCandidate = fs.realpathSync(candidate);
        const realRelative = path.relative(jobRoot, realCandidate);
        if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
          throw new Error('Recovery capsule symlink must remain inside the job mailbox directory.');
        }
        const stat = fs.statSync(realCandidate);
        if (!stat.isFile() || stat.size > RECOVERY_CAPSULE_MAX_BYTES) return undefined;
        const raw = fs.readFileSync(realCandidate, 'utf8');
        return parseRecoveryCapsule(raw, spec.jobId);
      };

      if (spec.recovery.capsulePath) {
        return readSafeCapsule(spec.recovery.capsulePath);
      }
      const fromRound = spec.recovery.fromRound || Math.max(1, spec.round - 1);
      const formattedRound = fromRound.toString().padStart(3, '0');
      return readSafeCapsule(path.join('rounds', formattedRound, 'recovery-capsule.json'));
    } catch (err) {
      logger.warn(`Recovery capsule could not be loaded for job ${spec.jobId}: ${String(err)}`);
      return undefined;
    }
  }

  private buildPlanRecoveryCapsule(
    spec: WorkJob,
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
        jobId: spec.jobId,
        round: spec.round,
        revision: spec.revision,
        role,
        originalGoal,
        acceptedPlan: '',
        solReview: '',
        ownerApproval: spec.ownerApproval,
        baseSha: spec.baseSha,
        executionMode: 'READ_ONLY',
        executionConstraints: ['READ_ONLY mode must not modify source files.', 'Use a fresh destination session for fallback.'],
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
        baseSha: spec.baseSha,
        headSha: spec.baseSha,
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

  private recordTargetFailure(selection: ResolvedWorkerSelection, failureClass: PlanResult['failureClass'] | undefined, retryAt?: string, rawEvidence?: string): void {
    if (!failureClass) return;
    const target = this.modelSelector.getTargetConfig(selection.targetId);
    if (!target) return;
    this.availability.recordFailure(target, failureClass, new Date().toISOString(), retryAt, rawEvidence, 'worker_result');
  }

  private sessionIdentityFromRecord(record: ReturnType<Ledger['getJobRecord']>): WorkerSessionIdentity | undefined {
    if (!record?.platform || !record.model || !record.worktreePath) return undefined;
    return {
      targetId: record.targetId,
      platform: record.platform,
      model: record.model,
      reasoning: record.reasoning,
      sessionId: record.platformSessionId || undefined,
      worktreeCwd: record.worktreePath,
      executionMode: record.lastHandledMode,
    };
  }

  private async getCompatibleRecoveryWorktree(
    spec: WorkJob,
    record: ReturnType<Ledger['getJobRecord']>,
    capsule: RecoveryCapsule | undefined,
  ): Promise<string | undefined> {
    if (spec.executionMode !== 'WORKTREE_WRITE' || !record?.worktreePath || !capsule) return undefined;
    if (!fs.existsSync(record.worktreePath) || capsule.currentState.inspectionFailed) return undefined;
    if (capsule.contract.executionMode && capsule.contract.executionMode !== spec.executionMode) return undefined;
    if (capsule.contract.baseSha !== spec.baseSha || capsule.currentState.baseSha !== spec.baseSha) return undefined;

    const expectedPath = path.resolve(capsule.currentState.worktreePath);
    const actualPath = path.resolve(record.worktreePath);
    const pathsMatch = process.platform === 'win32'
      ? expectedPath.toLowerCase() === actualPath.toLowerCase()
      : expectedPath === actualPath;
    if (!pathsMatch || !capsule.currentState.branch) return undefined;

    try {
      const [{ stdout: branch }, { stdout: head }] = await Promise.all([
        execFileAsync('git', ['-C', record.worktreePath, 'branch', '--show-current'], { windowsHide: true }),
        execFileAsync('git', ['-C', record.worktreePath, 'rev-parse', 'HEAD'], { windowsHide: true }),
      ]);
      if (branch.trim() !== capsule.currentState.branch.trim()) return undefined;
      if (capsule.currentState.headSha && head.trim() !== capsule.currentState.headSha.trim()) return undefined;
      return record.worktreePath;
    } catch {
      return undefined;
    }
  }

  private buildPreInvocationFailureCapsule(
    spec: WorkJob,
    role: WorkerRole,
    selection: ResolvedWorkerSelection | undefined,
    previous: ReturnType<Ledger['getJobRecord']>,
    failureClass: PlanResult['failureClass'],
    message: string,
  ): RecoveryCapsule {
    const worktreePath = previous?.worktreePath || (
      spec.executionMode === 'WORKTREE_WRITE'
        ? this.worktreeManager.getImplementWorktreePath(spec.projectId, spec.jobId)
        : this.worktreeManager.getPlanWorktreePath(spec.projectId, spec.jobId)
    );
    return buildRecoveryCapsule({
      contract: {
        jobId: spec.jobId,
        round: spec.round,
        revision: spec.revision,
        role,
        originalGoal: '',
        acceptedPlan: '',
        solReview: '',
        ownerApproval: spec.ownerApproval,
        baseSha: spec.baseSha,
        executionMode: spec.executionMode,
        executionConstraints: ['No worker invocation occurred after the bridge failed closed.'],
      },
      sourceWorker: {
        targetId: selection?.targetId || previous?.targetId,
        platform: selection?.platform || previous?.platform || 'unknown',
        model: selection?.modelId || previous?.model || spec.workerSelection?.model || 'unknown',
        reasoning: selection?.variant || previous?.reasoning || spec.workerSelection?.reasoning?.value,
        sessionId: previous?.platformSessionId || undefined,
        failureClass,
      },
      capturedHistory: {
        stdout: '',
        stderr: message,
        partialResponse: '',
        outputTruncated: false,
        sessionId: previous?.platformSessionId || undefined,
      },
      currentState: {
        worktreePath,
        branch: previous?.workerBranch || undefined,
        baseSha: spec.baseSha,
        headSha: previous?.currentHeadSha || spec.baseSha,
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

  private async publishPreInvocationFailure(
    spec: WorkJob,
    role: WorkerRole,
    selection: ResolvedWorkerSelection | undefined,
    previous: ReturnType<Ledger['getJobRecord']>,
    failureClass: PlanResult['failureClass'],
    message: string,
  ): Promise<void> {
    const capsule = this.buildPreInvocationFailureCapsule(spec, role, selection, previous, failureClass, message);
    const capsulePath = await this.mailboxSyncer.writeRecoveryCapsule(spec.jobId, spec.round, capsule);
    if (previous) {
      this.ledger.updateJobEvidence(spec.jobId, {
        recoveryCapsulePath: capsulePath,
        currentHeadSha: previous.currentHeadSha || spec.baseSha,
      });
      this.ledger.recordFinish(spec.jobId, 'BLOCKED', previous.platformSessionId);
    }
    const status: JobStatus = {
      schemaVersion: spec.schemaVersion || 2,
      jobId: spec.jobId,
      projectId: spec.projectId,
      observedRound: spec.round,
      observedRevision: spec.revision,
      observedPhase: spec.requestedPhase || (spec.executionMode === 'READ_ONLY' ? 'PLAN' : 'IMPLEMENT'),
      state: 'BLOCKED',
      updatedAt: new Date().toISOString(),
      baseSha: spec.baseSha,
      currentWorker: selection
        ? {
            targetId: selection.targetId,
            platform: selection.platform,
            model: selection.modelId,
            variant: selection.variant,
            reasoning: selection.variant,
            platformSessionId: previous?.platformSessionId || undefined,
            worktreeCwd: capsule.currentState.worktreePath,
            executionMode: spec.executionMode,
          }
        : null,
      recoveryCapsulePath: capsulePath,
      error: message,
    };
    await this.mailboxSyncer.writeJobStatus(spec.jobId, status);
    await this.mailboxTransport.stageAndCommitJobArtifacts(spec.jobId, `worker(${spec.jobId}): publish pre-invocation failure`);
    await this.mailboxTransport.pushWithRetry();
  }

  async init(): Promise<void> {
    logger.info('Initializing Worker Bridge Orchestrator...');
    const recovered = this.ledger.recoverInterruptedJobs((pid) => this.processManager.isPidAlive(pid));

    if (recovered.length > 0) {
      logger.warn(`Recovered ${recovered.length} interrupted job(s) from previous session.`);
      for (const rec of recovered) {
        logger.info(`Preserving evidence for interrupted job ${rec.jobId} at worktree: ${rec.worktreePath || 'N/A'}`);
        const status: JobStatus = {
          schemaVersion: 2,
          jobId: rec.jobId,
          projectId: rec.projectId,
          observedRound: rec.lastHandledRound,
          observedRevision: rec.lastHandledRevision,
          observedPhase: rec.lastHandledPhase,
          state: rec.state,
          updatedAt: new Date().toISOString(),
          baseSha: '',
          currentWorker: rec.platform
            ? {
                targetId: rec.targetId,
                platform: rec.platform,
                model: rec.model || '',
                variant: rec.reasoning,
                reasoning: rec.reasoning,
                platformSessionId: rec.platformSessionId || undefined,
                worktreeCwd: rec.worktreePath || undefined,
                executionMode: rec.lastHandledMode,
              }
            : null,
          workerBranch: rec.workerBranch,
          recoveryCapsulePath: rec.recoveryCapsulePath,
          summary:
            rec.state === 'INTERRUPTED_WITH_SOURCE_STATE'
              ? `Source effects were observed before interruption. Worktree evidence is preserved at: ${rec.worktreePath || 'N/A'}. Automatic fallback is prohibited; submit an explicit recovery round.`
              : `Job was interrupted due to bridge restart or process termination. Worktree evidence preserved at: ${rec.worktreePath || 'N/A'}. Will not auto-retry.`,
          error: 'Process interrupted during execution',
        };
        await this.mailboxSyncer.writeJobStatus(rec.jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          rec.jobId,
          `worker(${rec.jobId}): mark INTERRUPTED (evidence preserved)`
        );
      }
      await this.mailboxTransport.pushWithRetry();
    }
  }

  private async notify(title: string, message: string): Promise<void> {
    if (this.configManager.getConfig().notificationsEnabled) {
      await sendWindowsNotification({ title, message });
    }
  }

  async tick(): Promise<void> {
    const cfg = this.configManager.getConfig();

    // 1. Fetch & rebase mailbox
    const syncRes = await this.mailboxTransport.fetchAndRebase();
    if (syncRes.conflict) {
      logger.error(`Mailbox rebase conflict: ${syncRes.error}. Halting tick to prevent data loss.`);
      return;
    }

    // 2. Scan jobs
    const jobs = await this.mailboxSyncer.listJobs();

    for (const entry of jobs) {
      const jobId = entry.jobId;

      // Handle malformed job spec
      if (entry.parseError || !entry.spec) {
        logger.warn(`Job ${jobId} has parse error: ${entry.parseError}`);
        const status: JobStatus = {
          schemaVersion: 2,
          jobId,
          projectId: 'unknown',
          observedRound: 1,
          observedRevision: 0,
          observedPhase: 'PLAN',
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: '',
          error: `Malformed job.json: ${entry.parseError}`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          jobId,
          `worker(${jobId}): mark BLOCKED (malformed job.json)`
        );
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      const spec = entry.spec;

      // 3. Validate project allowlist
      const projValid = this.configManager.validateJobProjectId(spec.projectId);
      if (!projValid.ok) {
        logger.warn(`Job ${jobId} rejected: ${projValid.reason}`);
        const status: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: spec.requestedPhase || (spec.executionMode === 'READ_ONLY' ? 'PLAN' : 'IMPLEMENT'),
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          error: projValid.reason,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          jobId,
          `worker(${jobId}): mark BLOCKED (unauthorized project)`
        );
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      const projConfig = this.configManager.getProjectConfig(spec.projectId)!;

      // 4. Validate base SHA existence in target repository
      const shaValid = await verifyBaseSha(projConfig.path, spec.baseSha);
      if (!shaValid.valid) {
        logger.warn(`Job ${jobId} rejected: ${shaValid.error}`);
        const status: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: spec.requestedPhase || (spec.executionMode === 'READ_ONLY' ? 'PLAN' : 'IMPLEMENT'),
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          error: shaValid.error,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          jobId,
          `worker(${jobId}): mark BLOCKED (invalid base SHA)`
        );
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      // 5. Check Idempotency Ledger
      if (!this.ledger.shouldExecute(spec)) {
        continue;
      }

      // 6. Handle CANCEL phase
      if (spec.requestedPhase === 'CANCEL') {
        logger.info(`Processing CANCEL request for job ${jobId}`);

        let cancelEvidence = 'Job execution was cancelled by user request.';
        const record = this.ledger.getJobRecord(jobId);
        if (record?.worktreePath) {
          try {
            const { stdout: statusOut } = await execFileAsync(
              'git',
              ['-C', record.worktreePath, 'status', '--porcelain'],
              { windowsHide: true }
            );
            cancelEvidence += `\nFinal Worktree State:\n${statusOut.trim() || 'Clean'}`;
          } catch {}
        }

        await this.processManager.cancelJob(jobId);
        this.ledger.recordFinish(jobId, 'CANCELLED');

        const status: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: 'CANCEL',
          state: 'CANCELLED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          summary: cancelEvidence,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          jobId,
          `worker(${jobId}): mark CANCELLED (evidence captured)`
        );
        await this.mailboxTransport.pushWithRetry();
        await this.notify('Job Cancelled', `Job ${jobId} has been cancelled.`);
        continue;
      }

      // 7. Check Owner Approval Gate for WORKTREE_WRITE
      if (spec.executionMode === 'WORKTREE_WRITE') {
        const isApproved = spec.ownerApproval?.approved === true;
        // In v1 legacy, if requestedPhase was explicitly IMPLEMENT, it came from approved Sol handoff
        const isLegacyApproved = spec.schemaVersion === 1 && spec.requestedPhase === 'IMPLEMENT';

        if (!isApproved && !isLegacyApproved) {
          logger.warn(`Job ${jobId} blocked: WORKTREE_WRITE requires explicit owner approval.`);
          const status: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'IMPLEMENT',
            state: 'BLOCKED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            error: 'OWNER_APPROVAL_REQUIRED: Source write execution requires explicit owner approval.',
            blockers: ['Awaiting owner approval for implementation contract.'],
          };
          await this.mailboxSyncer.writeJobStatus(jobId, status);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): mark BLOCKED (owner approval required)`
          );
          await this.mailboxTransport.pushWithRetry();
          continue;
        }
      }

      // 8. Resolve Worker Platform and Model Selection
      const role = this.roleForSpec(spec);
      const prevRecord = this.ledger.getJobRecord(jobId);
      const recoveryCapsule = await this.readRecoveryCapsule(spec);
      const automaticReviewerAvoidance =
        role === 'REVIEWER' && this.configManager.getConfig().selectionPolicy?.reviewerPreferDifferentTarget
          ? spec.workerSelection?.avoidTargetId || prevRecord?.targetId
          : spec.workerSelection?.avoidTargetId;
      let resolvedWorker: ResolvedWorkerSelection;
      const previousSessionIdentity = this.sessionIdentityFromRecord(prevRecord);
      try {
        const requestedSelection =
          spec.sessionPolicy === 'CONTINUE' &&
          prevRecord?.targetId &&
          (!spec.workerSelection?.targetId &&
            (!spec.workerSelection?.model || ['auto', 'your call'].includes(spec.workerSelection.model.toLowerCase())))
            ? {
                targetId: prevRecord.targetId,
                platform: prevRecord.platform,
                model: prevRecord.model,
                reasoning: prevRecord.reasoning
                  ? { strategy: 'explicit' as const, value: prevRecord.reasoning }
                  : undefined,
              }
            : spec.sessionPolicy === 'CONTINUE' &&
                prevRecord?.targetId &&
                spec.workerSelection?.targetId === prevRecord.targetId &&
                !spec.workerSelection.model &&
                !!prevRecord.model
              ? {
                  ...spec.workerSelection,
                  platform: spec.workerSelection.platform || prevRecord.platform,
                  model: prevRecord.model,
                  reasoning: spec.workerSelection.reasoning || (prevRecord.reasoning
                    ? { strategy: 'explicit' as const, value: prevRecord.reasoning }
                    : undefined),
                }
              : spec.workerSelection;
        if (requestedSelection?.targetId && spec.sessionPolicy === 'CONTINUE' && prevRecord?.targetId === requestedSelection.targetId) {
          if (!this.availability.isEligible(requestedSelection.targetId)) {
            throw new Error(`MODEL_SELECTION_ERROR: CONTINUE target "${requestedSelection.targetId}" is unavailable.`);
          }
        }
        resolvedWorker = await this.modelSelector.resolveSelection(
          requestedSelection,
          role,
          new Set<string>(),
          automaticReviewerAvoidance
        );
      } catch (err: any) {
        logger.warn(`Model resolution failed for job ${jobId}: ${err.message}`);
        if (err instanceof WorkerAdapterError) {
          await this.publishPreInvocationFailure(spec, role, undefined, prevRecord, err.failureClass, err.message);
          continue;
        }
        const status: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: spec.requestedPhase || (spec.executionMode === 'READ_ONLY' ? 'PLAN' : 'IMPLEMENT'),
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          error: err.message,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(
          jobId,
          `worker(${jobId}): mark BLOCKED (model resolution error)`
        );
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      const adapter = this.adapterRegistry.get(resolvedWorker.platform);
      if (!adapter) {
        logger.error(`Adapter for platform "${resolvedWorker.platform}" not found`);
        continue;
      }

      // 9. Session Policy Management
      let sessionIdToUse: string | undefined;
      let sessionIdentityToUse: WorkerSessionIdentity | undefined;
      const recoveryWorktreeCwd = await this.getCompatibleRecoveryWorktree(spec, prevRecord, recoveryCapsule);
      const continuationWorktreeCwd = spec.sessionPolicy === 'CONTINUE' ? recoveryWorktreeCwd : undefined;

      if (spec.sessionPolicy === 'CONTINUE' && !prevRecord?.platformSessionId) {
        await this.publishPreInvocationFailure(
          spec,
          role,
          resolvedWorker,
          prevRecord,
          'SESSION_ID_UNAVAILABLE',
          'SESSION_ID_UNAVAILABLE: CONTINUE requires an exact persisted platform session ID; no worker was invoked.',
        );
        continue;
      }

      if (
        spec.sessionPolicy === 'CONTINUE' &&
        prevRecord?.platformSessionId &&
        previousSessionIdentity &&
        this.modelSelector.canContinueSession(
          previousSessionIdentity,
          resolvedWorker,
          spec.executionMode,
          continuationWorktreeCwd || '',
        )
      ) {
        sessionIdToUse = prevRecord.platformSessionId;
        sessionIdentityToUse = previousSessionIdentity;
        logger.info(`Continuing existing ${resolvedWorker.platform} session: ${sessionIdToUse}`);
      } else {
        logger.info(`Starting FRESH ${resolvedWorker.platform} session for job ${jobId}`);
      }

      // 10. Handle READ_ONLY Mode (plan, design, investigate, review, audit)
      if (spec.executionMode === 'READ_ONLY') {
        const goalText = await this.mailboxSyncer.readJobGoal(jobId);
        if (!goalText) {
          logger.warn(`Job ${jobId} missing brief.md or goal.md for READ_ONLY mode`);
          const status: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'PLAN',
            state: 'BLOCKED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            error: 'Missing brief.md or goal.md in mailbox for READ_ONLY mode.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, status);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): mark BLOCKED (missing brief.md)`
          );
          await this.mailboxTransport.pushWithRetry();
          continue;
        }

        // Mark PLANNING / WORKER_RUNNING state
        const planWorktree = this.worktreeManager.getPlanWorktreePath(spec.projectId, jobId);
        const runningStatus: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: spec.requestedPhase || 'PLAN',
          state: spec.schemaVersion === 1 ? 'PLANNING' : 'WORKER_RUNNING',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          currentWorker: {
            targetId: resolvedWorker.targetId,
            platform: resolvedWorker.platform,
            model: resolvedWorker.modelId,
            variant: resolvedWorker.variant,
            reasoning: resolvedWorker.variant,
            platformSessionId: sessionIdToUse,
            worktreeCwd: planWorktree,
            executionMode: 'READ_ONLY',
          },
          summary: `Worker on ${resolvedWorker.platform} (${resolvedWorker.modelId}) is executing read-only investigation and generating plan...`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, runningStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark WORKER_RUNNING`);
        await this.mailboxTransport.pushWithRetry();

        this.ledger.recordStart(
          jobId,
          spec.projectId,
          'READ_ONLY',
          spec.intent,
          spec.round,
          spec.revision,
          null,
          resolvedWorker.platform,
          resolvedWorker.modelId,
          planWorktree,
          null,
          sessionIdToUse,
          resolvedWorker.targetId,
          role,
          false,
          undefined,
          spec.baseSha,
          resolvedWorker.variant
        );

        // Execute READ_ONLY worker with fallback handling if quota exhausted
        let currentWorkerSelection = resolvedWorker;
        let currentAdapter = adapter;
        let planRes = await this.planWorker.execute(
          jobId,
          spec.projectId,
          projConfig.path,
          spec.baseSha,
          goalText,
          spec.timeoutSeconds,
          currentAdapter,
          currentWorkerSelection.modelId,
          currentWorkerSelection.variant,
          sessionIdToUse,
          spec.round,
          recoveryCapsule,
          currentWorkerSelection.targetId,
          sessionIdentityToUse
        );
        planRes = { ...planRes, targetId: currentWorkerSelection.targetId };

        const allowFallback = this.allowFallbackFor(spec);

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
          this.recordTargetFailure(currentWorkerSelection, planRes.failureClass, planRes.retryAt, planRes.rawFailureEvidence);
          const failedCapsule = this.buildPlanRecoveryCapsule(spec, role, currentWorkerSelection, planRes, goalText);
          planRes = { ...planRes, recoveryEvidence: failedCapsule };
          await this.mailboxSyncer.writeRecoveryCapsule(jobId, spec.round, failedCapsule);
          logger.warn(
            `Worker ${currentWorkerSelection.targetId} failed with ${planRes.failureClass}. Attempting fallback (attempt ${attempts}/${maxFallbackAttempts})...`
          );

          try {
            currentWorkerSelection = await this.modelSelector.getNextFallback(
              currentWorkerSelection,
              role,
              {
                failedTargetIds,
                authorizedFallback: spec.workerSelection?.fallbackSelection,
              }
            );
            currentAdapter = this.adapterRegistry.get(currentWorkerSelection.platform)!;

            planRes = await this.planWorker.execute(
              jobId,
              spec.projectId,
              projConfig.path,
              spec.baseSha,
              goalText,
              spec.timeoutSeconds,
              currentAdapter,
              currentWorkerSelection.modelId,
              currentWorkerSelection.variant,
              undefined, // Fresh session on fallback
              spec.round,
              recoveryCapsule,
              currentWorkerSelection.targetId
            );
            planRes = { ...planRes, targetId: currentWorkerSelection.targetId };
          } catch {
            break;
          }
        }

        if (planRes.clean && planRes.exitCode === 0) {
          const successfulTarget = this.modelSelector.getTargetConfig(currentWorkerSelection.targetId);
          this.availability.recordSuccess(currentWorkerSelection.targetId, successfulTarget);
          await this.mailboxSyncer.writeJobPlan(jobId, planRes.planText, spec.round);
          this.ledger.updateJobEvidence(jobId, {
            platform: planRes.platform,
            model: planRes.model,
            reasoning: planRes.sessionIdentity?.reasoning || planRes.variant,
            platformSessionId: planRes.sessionIdentity?.sessionId || planRes.sessionId || null,
            targetId: currentWorkerSelection.targetId,
            role,
            currentHeadSha: spec.baseSha,
          });
          this.ledger.recordFinish(
            jobId,
            spec.schemaVersion === 1 ? 'PLAN_READY' : 'WORKER_RETURNED',
            planRes.sessionId
          );

          const readyStatus: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'PLAN',
            state: spec.schemaVersion === 1 ? 'PLAN_READY' : 'WORKER_RETURNED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            currentWorker: {
              targetId: currentWorkerSelection.targetId,
              platform: planRes.platform,
              model: planRes.model,
              variant: planRes.variant,
              reasoning: planRes.sessionIdentity?.reasoning || planRes.variant,
              platformSessionId: planRes.sessionId,
              worktreeCwd: planRes.worktreePath,
              executionMode: 'READ_ONLY',
            },
            exitCode: 0,
            summary: `Implementation plan generated successfully by ${planRes.platform} (${planRes.model}). Read-only assertions verified. Ready for Sol review.`,
          };
          await this.mailboxSyncer.writeJobStatus(jobId, readyStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): publish round ${spec.round} plan and mark WORKER_RETURNED`
          );
          await this.mailboxTransport.pushWithRetry();
          await this.notify(
            'Worker Plan Ready',
            `Plan for ${jobId} (${spec.projectId}) by ${planRes.platform} is ready for Sol review.`
          );
        } else {
          if (planRes.failureClass === 'QUOTA_EXHAUSTED' || planRes.failureClass === 'RATE_LIMITED') {
            this.recordTargetFailure(currentWorkerSelection, planRes.failureClass, planRes.retryAt, planRes.rawFailureEvidence);
            const failedCapsule =
              planRes.recoveryEvidence || this.buildPlanRecoveryCapsule(spec, role, currentWorkerSelection, planRes, goalText);
            const capsulePath = await this.mailboxSyncer.writeRecoveryCapsule(jobId, spec.round, failedCapsule);
            this.ledger.updateJobEvidence(jobId, {
              platform: planRes.platform,
              model: planRes.model,
              reasoning: planRes.sessionIdentity?.reasoning || planRes.variant,
              platformSessionId: planRes.sessionIdentity?.sessionId || planRes.sessionId || null,
              targetId: currentWorkerSelection.targetId,
              role,
              recoveryCapsulePath: capsulePath,
              currentHeadSha: spec.baseSha,
            });
          }
          this.ledger.recordFinish(jobId, 'FAILED', planRes.sessionId);
          const failStatus: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'PLAN',
            state: 'FAILED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            currentWorker: {
              targetId: currentWorkerSelection.targetId,
              platform: planRes.platform,
              model: planRes.model,
              variant: planRes.variant,
              reasoning: planRes.sessionIdentity?.reasoning || planRes.variant,
              platformSessionId: planRes.sessionId,
              worktreeCwd: planRes.worktreePath,
              executionMode: 'READ_ONLY',
            },
            exitCode: planRes.exitCode,
            error: planRes.error || 'Plan generation failed.',
            summary: planRes.clean
              ? `Worker process exited with error (${planRes.failureClass || 'PROCESS_FAILED'}).`
              : 'READ_ONLY mode violated read-only constraint.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, failStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): mark FAILED (plan error)`
          );
          await this.mailboxTransport.pushWithRetry();
          await this.notify('Worker Plan Failed', `Plan generation for ${jobId} failed: ${planRes.error}`);
        }
        continue;
      }

      // 11. Handle WORKTREE_WRITE Mode (implement, fix)
      if (spec.executionMode === 'WORKTREE_WRITE') {
        const goalText = (await this.mailboxSyncer.readJobGoal(jobId)) || '';
        const priorRound = spec.recovery?.fromRound || spec.round;
        const planText = await this.mailboxSyncer.readJobPlan(jobId, priorRound);
        const reviewText = await this.mailboxSyncer.readJobReview(jobId, priorRound);

        if (!planText || !reviewText) {
          logger.warn(`Job ${jobId} missing plan or review for WORKTREE_WRITE mode`);
          const status: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'IMPLEMENT',
            state: 'BLOCKED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            error: 'Missing plan or review in mailbox for WORKTREE_WRITE mode.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, status);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): mark BLOCKED (missing plan/review)`
          );
          await this.mailboxTransport.pushWithRetry();
          continue;
        }

        // Mark IMPLEMENTING / WORKER_RUNNING state
        const preservedWorktreePath = spec.recovery?.enabled ? recoveryWorktreeCwd : undefined;
        const impWorktree = preservedWorktreePath || this.worktreeManager.getImplementWorktreePath(spec.projectId, jobId);
        const impStatus: JobStatus = {
          schemaVersion: spec.schemaVersion || 2,
          jobId,
          projectId: spec.projectId,
          observedRound: spec.round,
          observedRevision: spec.revision,
          observedPhase: spec.requestedPhase || 'IMPLEMENT',
          state: spec.schemaVersion === 1 ? 'IMPLEMENTING' : 'WORKER_RUNNING',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          currentWorker: {
            targetId: resolvedWorker.targetId,
            platform: resolvedWorker.platform,
            model: resolvedWorker.modelId,
            variant: resolvedWorker.variant,
            reasoning: resolvedWorker.variant,
            platformSessionId: sessionIdToUse,
            worktreeCwd: impWorktree,
            executionMode: 'WORKTREE_WRITE',
          },
          summary: `Worker on ${resolvedWorker.platform} (${resolvedWorker.modelId}) is implementing code in isolated worktree...`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, impStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark WORKER_RUNNING`);
        await this.mailboxTransport.pushWithRetry();

        const workerBranch = prevRecord?.workerBranch || this.worktreeManager.getWorkerBranchName(spec.projectId, jobId);
        this.ledger.recordStart(
          jobId,
          spec.projectId,
          'WORKTREE_WRITE',
          spec.intent,
          spec.round,
          spec.revision,
          null,
          resolvedWorker.platform,
          resolvedWorker.modelId,
          impWorktree,
          workerBranch,
          sessionIdToUse,
          resolvedWorker.targetId,
          role,
          false,
          undefined,
          prevRecord?.currentHeadSha || null,
          resolvedWorker.variant
        );

        // Execute WORKTREE_WRITE worker
        let currentWorkerSelection = resolvedWorker;
        let currentAdapter = adapter;
        let impRes = await this.implementWorker.execute(
          jobId,
          spec.projectId,
          projConfig,
          spec.baseSha,
          goalText,
          planText,
          reviewText,
          cfg.pushWorkerBranches,
          cfg.mailboxRemote || 'origin',
          spec.timeoutSeconds,
          adapter,
          resolvedWorker.modelId,
          resolvedWorker.variant,
          sessionIdToUse,
          spec.round,
          recoveryCapsule,
          preservedWorktreePath,
          currentWorkerSelection.targetId,
          spec.revision,
          spec.ownerApproval,
          sessionIdentityToUse
        );
        impRes = { ...impRes, targetId: currentWorkerSelection.targetId };

        const allowFallback = this.allowFallbackFor(spec);
        const failedTargetIds = new Set<string>();
        let attempts = 0;
        const maxFallbackAttempts = cfg.selectionPolicy?.maxFallbackAttempts ?? 3;
        while (
          (impRes.failureClass === 'QUOTA_EXHAUSTED' || impRes.failureClass === 'RATE_LIMITED') &&
          !impRes.sourceEffectsPresent &&
          allowFallback &&
          attempts < maxFallbackAttempts
        ) {
          attempts++;
          failedTargetIds.add(currentWorkerSelection.targetId);
          this.recordTargetFailure(currentWorkerSelection, impRes.failureClass, impRes.retryAt, impRes.rawFailureEvidence);
          if (impRes.recoveryEvidence) {
            await this.mailboxSyncer.writeRecoveryCapsule(jobId, spec.round, impRes.recoveryEvidence);
          }
          try {
            currentWorkerSelection = await this.modelSelector.getNextFallback(
              currentWorkerSelection,
              role,
              {
                failedTargetIds,
                avoidTargetId: automaticReviewerAvoidance,
                authorizedFallback: spec.workerSelection?.fallbackSelection,
              }
            );
            currentAdapter = this.adapterRegistry.get(currentWorkerSelection.platform)!;
            impRes = await this.implementWorker.execute(
              jobId,
              spec.projectId,
              projConfig,
              spec.baseSha,
              goalText,
              planText,
              reviewText,
              cfg.pushWorkerBranches,
              cfg.mailboxRemote || 'origin',
              spec.timeoutSeconds,
              currentAdapter,
              currentWorkerSelection.modelId,
              currentWorkerSelection.variant,
              undefined,
              spec.round,
              recoveryCapsule,
                undefined,
                currentWorkerSelection.targetId,
                spec.revision,
                spec.ownerApproval,
                undefined
            );
            impRes = { ...impRes, targetId: currentWorkerSelection.targetId };
          } catch {
            break;
          }
        }

        await this.mailboxSyncer.writeJobResult(jobId, impRes.reportText, spec.round);

        let recoveryCapsulePath: string | undefined;
        if (impRes.recoveryEvidence) {
          recoveryCapsulePath = await this.mailboxSyncer.writeRecoveryCapsule(jobId, spec.round, impRes.recoveryEvidence);
          impRes = { ...impRes, recoveryCapsulePath };
        }

        if (impRes.exitCode === 0 && !impRes.error && impRes.bridgeVerificationPassed) {
          this.availability.recordSuccess(
            currentWorkerSelection.targetId,
            this.modelSelector.getTargetConfig(currentWorkerSelection.targetId)
          );
          this.ledger.updateJobEvidence(jobId, {
            platform: impRes.platform,
            model: impRes.model,
            reasoning: impRes.sessionIdentity?.reasoning || impRes.variant,
            platformSessionId: impRes.sessionIdentity?.sessionId || impRes.sessionId || null,
            targetId: currentWorkerSelection.targetId,
            role,
            sourceEffectsPresent: impRes.sourceEffectsPresent,
            worktreePath: null,
            workerBranch: impRes.workerBranch,
            recoveryCapsulePath: recoveryCapsulePath || null,
            currentHeadSha: impRes.currentHeadSha || impRes.headSha || null,
          });
          this.ledger.recordFinish(
            jobId,
            spec.schemaVersion === 1 ? 'IMPLEMENTATION_READY' : 'WORKER_RETURNED',
            impRes.sessionId
          );
          const readyStatus: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'IMPLEMENT',
            state: spec.schemaVersion === 1 ? 'IMPLEMENTATION_READY' : 'WORKER_RETURNED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            currentWorker: {
              targetId: currentWorkerSelection.targetId,
              platform: impRes.platform,
              model: impRes.model,
              variant: impRes.variant,
              reasoning: impRes.sessionIdentity?.reasoning || impRes.variant,
              platformSessionId: impRes.sessionId,
              worktreeCwd: impRes.worktreePath,
              executionMode: 'WORKTREE_WRITE',
            },
            workerBranch: impRes.workerBranch,
            headSha: impRes.headSha,
            recoveryCapsulePath: recoveryCapsulePath || null,
            exitCode: 0,
            summary: `Implementation completed on ${impRes.workerBranch} by ${impRes.platform} (${impRes.model}). Authoritative Bridge verification passed.`,
          };
          await this.mailboxSyncer.writeJobStatus(jobId, readyStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): publish result and mark IMPLEMENTATION_READY`
          );
          await this.mailboxTransport.pushWithRetry();
          await this.notify(
            'Implementation Ready',
            `Implementation for ${jobId} is ready on ${impRes.workerBranch} by ${impRes.platform}.`
          );
        } else {
          if (impRes.failureClass === 'QUOTA_EXHAUSTED' || impRes.failureClass === 'RATE_LIMITED') {
            this.recordTargetFailure(currentWorkerSelection, impRes.failureClass, impRes.retryAt, impRes.rawFailureEvidence);
          }
          const interruptedWithSourceState = impRes.sourceEffectsPresent === true;
          this.ledger.updateJobEvidence(jobId, {
            platform: impRes.platform,
            model: impRes.model,
            reasoning: impRes.sessionIdentity?.reasoning || impRes.variant,
            platformSessionId: impRes.sessionIdentity?.sessionId || impRes.sessionId || null,
            targetId: currentWorkerSelection.targetId,
            role,
            sourceEffectsPresent: impRes.sourceEffectsPresent,
            worktreePath: impRes.worktreePath || null,
            workerBranch: impRes.workerBranch,
            recoveryCapsulePath: recoveryCapsulePath || null,
            currentHeadSha: impRes.currentHeadSha || impRes.headSha || null,
          });
          this.ledger.recordFinish(
            jobId,
            interruptedWithSourceState ? 'INTERRUPTED_WITH_SOURCE_STATE' : 'FAILED',
            impRes.sessionId
          );
          const failStatus: JobStatus = {
            schemaVersion: spec.schemaVersion || 2,
            jobId,
            projectId: spec.projectId,
            observedRound: spec.round,
            observedRevision: spec.revision,
            observedPhase: spec.requestedPhase || 'IMPLEMENT',
            state: interruptedWithSourceState ? 'INTERRUPTED_WITH_SOURCE_STATE' : 'FAILED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            currentWorker: {
              targetId: currentWorkerSelection.targetId,
              platform: impRes.platform,
              model: impRes.model,
              variant: impRes.variant,
              reasoning: impRes.sessionIdentity?.reasoning || impRes.variant,
              platformSessionId: impRes.sessionId,
              worktreeCwd: impRes.worktreePath,
              executionMode: 'WORKTREE_WRITE',
            },
            workerBranch: impRes.workerBranch,
            headSha: impRes.headSha,
            recoveryCapsulePath: recoveryCapsulePath || null,
            exitCode: impRes.exitCode,
            error: impRes.error || 'Implementation or verification failed.',
            summary: interruptedWithSourceState
              ? `Implementation stopped after source effects were observed. Worktree preserved at ${impRes.worktreePath || 'the recorded worker path'}. Submit an explicit recovery round.`
              : `Implementation attempt failed (Bridge Verification: ${impRes.bridgeVerificationPassed ? 'PASSED' : 'FAILED'}).`,
          };
          await this.mailboxSyncer.writeJobStatus(jobId, failStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(
            jobId,
            `worker(${jobId}): publish result.md and mark FAILED`
          );
          await this.mailboxTransport.pushWithRetry();
          await this.notify('Implementation Failed', `Implementation for ${jobId} failed: ${impRes.error}`);
        }
      }
    }
  }

  async startLoop(): Promise<void> {
    await this.init();
    this.isRunning = true;
    const intervalMs = this.configManager.getConfig().pollIntervalSeconds! * 1000;

    logger.info(`Worker bridge started polling mailbox every ${intervalMs / 1000}s. Press Ctrl+C to stop.`);

    while (this.isRunning) {
      try {
        await this.tick();
      } catch (err: any) {
        logger.error(`Error during orchestrator polling tick: ${err.message || String(err)}`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void {
    logger.info('Stopping orchestrator loop...');
    this.isRunning = false;
  }
}
