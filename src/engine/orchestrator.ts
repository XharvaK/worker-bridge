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
  PlanResult,
  RecoveryCapsule,
  WorkerEvidence,
  WorkerRole,
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

      this.adapterRegistry.register(new AntigravityAdapter(agyExe, agyModel, this.processManager));
      this.adapterRegistry.register(new OpenCodeAdapter(opencodeExe, opencodeModel, this.processManager));
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
    if (selection?.allowFallback === true) return true;
    if (selection?.allowFallback === false) return false;

    const requestedModel = selection?.model?.trim().toLowerCase();
    const explicitTarget = Boolean(
      selection?.targetId || (requestedModel && !['auto', 'your call'].includes(requestedModel))
    );
    if (explicitTarget) return false;

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
        executionConstraints: ['READ_ONLY mode must not modify source files.', 'Use a fresh destination session for fallback.'],
      },
      sourceWorker: {
        targetId: selection.targetId,
        platform: result.platform,
        model: result.model,
        reasoning: result.variant,
        sessionId: result.sessionId,
        requestPrompt: '',
        failureClass: result.failureClass,
        retryAt: result.retryAt,
      },
      capturedHistory: evidence,
      currentState: {
        worktreePath: 'not-preserved-read-only-worktree',
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
            ? { targetId: rec.targetId, platform: rec.platform, model: rec.model || '' }
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
      try {
        const requestedSelection =
          spec.sessionPolicy === 'CONTINUE' &&
          prevRecord?.targetId &&
          (!spec.workerSelection?.targetId &&
            (!spec.workerSelection?.model || ['auto', 'your call'].includes(spec.workerSelection.model.toLowerCase())))
            ? { targetId: prevRecord.targetId }
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

      if (
        spec.sessionPolicy === 'CONTINUE' &&
        prevRecord?.platformSessionId &&
        this.modelSelector.canContinueSession(
          {
            targetId: prevRecord.targetId,
            platform: prevRecord.platform,
            model: prevRecord.model,
          },
          resolvedWorker
        )
      ) {
        sessionIdToUse = prevRecord.platformSessionId;
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
            platformSessionId: sessionIdToUse,
          },
          summary: `Worker on ${resolvedWorker.platform} (${resolvedWorker.modelId}) is executing read-only investigation and generating plan...`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, runningStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark WORKER_RUNNING`);
        await this.mailboxTransport.pushWithRetry();

        const planWorktree = this.worktreeManager.getPlanWorktreePath(spec.projectId, jobId);
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
          role
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
          recoveryCapsule
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
              failedTargetIds
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
              recoveryCapsule
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
              platformSessionId: planRes.sessionId,
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
              platformSessionId: planRes.sessionId,
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
            platformSessionId: sessionIdToUse,
          },
          summary: `Worker on ${resolvedWorker.platform} (${resolvedWorker.modelId}) is implementing code in isolated worktree...`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, impStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark WORKER_RUNNING`);
        await this.mailboxTransport.pushWithRetry();

        const preservedWorktreePath = spec.recovery?.enabled ? prevRecord?.worktreePath || undefined : undefined;
        const impWorktree = preservedWorktreePath || this.worktreeManager.getImplementWorktreePath(spec.projectId, jobId);
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
          prevRecord?.currentHeadSha || null
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
          spec.ownerApproval
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
              failedTargetIds,
              undefined,
              automaticReviewerAvoidance
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
              spec.ownerApproval
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
              platformSessionId: impRes.sessionId,
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
              platformSessionId: impRes.sessionId,
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
