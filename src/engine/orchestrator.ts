import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../config.js';
import { Ledger } from './ledger.js';
import { ProcessManager } from './process-manager.js';
import { MailboxSyncer } from '../mailbox/syncer.js';
import { MailboxTransport } from '../mailbox/transport.js';
import { WorktreeManager } from '../git/worktree.js';
import { verifyBaseSha } from '../git/repo-guard.js';
import { AgyAdapter } from '../worker/agy-adapter.js';
import { PlanWorker } from '../worker/plan-worker.js';
import { ImplementWorker } from '../worker/implement-worker.js';
import { sendWindowsNotification } from '../utils/notifier.js';
import { logger } from '../utils/logger.js';
import { JobStatus } from '../types.js';

const execFileAsync = promisify(execFile);

export class Orchestrator {
  private configManager: ConfigManager;
  private ledger: Ledger;
  private processManager: ProcessManager;
  private mailboxSyncer: MailboxSyncer;
  private mailboxTransport: MailboxTransport;
  private worktreeManager: WorktreeManager;
  private agyAdapter: AgyAdapter;
  private planWorker: PlanWorker;
  private implementWorker: ImplementWorker;
  private isRunning = false;

  constructor(configManager: ConfigManager, customLedger?: Ledger) {
    this.configManager = configManager;
    const cfg = configManager.getConfig();

    this.ledger = customLedger || new Ledger();
    this.processManager = new ProcessManager();
    this.mailboxSyncer = new MailboxSyncer(cfg.mailboxRepoPath);
    this.mailboxTransport = new MailboxTransport(cfg.mailboxRepoPath, cfg.mailboxRemote, 'main');
    this.worktreeManager = new WorktreeManager(cfg.workerRootDir);
    this.agyAdapter = new AgyAdapter(cfg.agyExecutable, cfg.workerModel, this.processManager);
    this.planWorker = new PlanWorker(this.worktreeManager, this.agyAdapter);
    this.implementWorker = new ImplementWorker(this.worktreeManager, this.agyAdapter);
  }

  async init(): Promise<void> {
    logger.info('Initializing Gemini Worker Bridge Orchestrator...');
    const recovered = this.ledger.recoverInterruptedJobs((pid) => this.processManager.isPidAlive(pid));

    if (recovered.length > 0) {
      logger.warn(`Recovered ${recovered.length} interrupted job(s) from previous session.`);
      for (const rec of recovered) {
        logger.info(`Preserving evidence for interrupted job ${rec.jobId} at worktree: ${rec.worktreePath || 'N/A'}`);
        const status: JobStatus = {
          schemaVersion: 1,
          jobId: rec.jobId,
          projectId: rec.projectId,
          observedPhase: rec.lastHandledPhase,
          observedRevision: rec.lastHandledRevision,
          state: 'INTERRUPTED',
          updatedAt: new Date().toISOString(),
          baseSha: '',
          workerBranch: rec.workerBranch,
          summary: `Job was interrupted due to bridge restart or process termination. Worktree evidence preserved at: ${rec.worktreePath || 'N/A'}. Will not auto-retry.`,
          error: 'Process interrupted during execution',
        };
        await this.mailboxSyncer.writeJobStatus(rec.jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(rec.jobId, `worker(${rec.jobId}): mark INTERRUPTED (evidence preserved)`);
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
          schemaVersion: 1,
          jobId,
          projectId: 'unknown',
          observedPhase: 'PLAN',
          observedRevision: 0,
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: '',
          error: `Malformed job.json: ${entry.parseError}`,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark BLOCKED (malformed job.json)`);
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      const spec = entry.spec;

      // 3. Validate project allowlist
      const projValid = this.configManager.validateJobProjectId(spec.projectId);
      if (!projValid.ok) {
        logger.warn(`Job ${jobId} rejected: ${projValid.reason}`);
        const status: JobStatus = {
          schemaVersion: 1,
          jobId,
          projectId: spec.projectId,
          observedPhase: spec.requestedPhase,
          observedRevision: spec.revision,
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          error: projValid.reason,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark BLOCKED (unauthorized project)`);
        await this.mailboxTransport.pushWithRetry();
        continue;
      }

      const projConfig = this.configManager.getProjectConfig(spec.projectId)!;

      // 4. Validate base SHA existence in target repository
      const shaValid = await verifyBaseSha(projConfig.path, spec.baseSha);
      if (!shaValid.valid) {
        logger.warn(`Job ${jobId} rejected: ${shaValid.error}`);
        const status: JobStatus = {
          schemaVersion: 1,
          jobId,
          projectId: spec.projectId,
          observedPhase: spec.requestedPhase,
          observedRevision: spec.revision,
          state: 'BLOCKED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          error: shaValid.error,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark BLOCKED (invalid base SHA)`);
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

        // Capture evidence before cleanup
        let cancelEvidence = 'Job execution was cancelled by user request.';
        const record = this.ledger.getJobRecord(jobId);
        if (record?.worktreePath) {
          try {
            const { stdout: statusOut } = await execFileAsync('git', ['-C', record.worktreePath, 'status', '--porcelain'], { windowsHide: true });
            cancelEvidence += `\nFinal Worktree State:\n${statusOut.trim() || 'Clean'}`;
          } catch {}
        }

        await this.processManager.cancelJob(jobId);
        this.ledger.recordFinish(jobId, 'CANCELLED');

        const status: JobStatus = {
          schemaVersion: 1,
          jobId,
          projectId: spec.projectId,
          observedPhase: 'CANCEL',
          observedRevision: spec.revision,
          state: 'CANCELLED',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          summary: cancelEvidence,
        };
        await this.mailboxSyncer.writeJobStatus(jobId, status);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark CANCELLED (evidence captured)`);
        await this.mailboxTransport.pushWithRetry();
        await this.notify('Job Cancelled', `Job ${jobId} has been cancelled.`);
        continue;
      }

      // 7. Handle PLAN phase
      if (spec.requestedPhase === 'PLAN') {
        const goalText = await this.mailboxSyncer.readJobGoal(jobId);
        if (!goalText) {
          logger.warn(`Job ${jobId} missing goal.md for PLAN phase`);
          const status: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'PLAN',
            observedRevision: spec.revision,
            state: 'BLOCKED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            error: 'Missing goal.md in mailbox for PLAN phase.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, status);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark BLOCKED (missing goal.md)`);
          await this.mailboxTransport.pushWithRetry();
          continue;
        }

        // Mark PLANNING state
        const planningStatus: JobStatus = {
          schemaVersion: 1,
          jobId,
          projectId: spec.projectId,
          observedPhase: 'PLAN',
          observedRevision: spec.revision,
          state: 'PLANNING',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          summary: 'Gemini worker is investigating codebase with read-only permissions and generating implementation plan...',
        };
        await this.mailboxSyncer.writeJobStatus(jobId, planningStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark PLANNING`);
        await this.mailboxTransport.pushWithRetry();

        const planWorktree = this.worktreeManager.getPlanWorktreePath(spec.projectId, jobId);
        this.ledger.recordStart(jobId, spec.projectId, 'PLAN', spec.revision, null, planWorktree);

        // Execute PLAN worker
        const planRes = await this.planWorker.execute(
          jobId,
          spec.projectId,
          projConfig.path,
          spec.baseSha,
          goalText,
          spec.timeoutSeconds
        );

        if (planRes.clean && planRes.exitCode === 0) {
          await this.mailboxSyncer.writeJobPlan(jobId, planRes.planText);
          this.ledger.recordFinish(jobId, 'PLAN_READY');

          const readyStatus: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'PLAN',
            observedRevision: spec.revision,
            state: 'PLAN_READY',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            exitCode: 0,
            summary: 'Implementation plan generated successfully. Read-only assertions verified (0 file modifications).',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, readyStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): publish plan.md and mark PLAN_READY`);
          await this.mailboxTransport.pushWithRetry();
          await this.notify('Gemini Plan Ready', `Plan for ${jobId} (${spec.projectId}) is ready for Sol review.`);
        } else {
          this.ledger.recordFinish(jobId, 'FAILED');
          const failStatus: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'PLAN',
            observedRevision: spec.revision,
            state: 'FAILED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            exitCode: planRes.exitCode,
            error: planRes.error || 'Plan generation failed.',
            summary: planRes.clean ? 'Plan worker exited with error.' : 'PLAN mode violated read-only constraint.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, failStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark FAILED (plan error)`);
          await this.mailboxTransport.pushWithRetry();
          await this.notify('Gemini Plan Failed', `Plan generation for ${jobId} failed: ${planRes.error}`);
        }
        continue;
      }

      // 8. Handle IMPLEMENT phase
      if (spec.requestedPhase === 'IMPLEMENT') {
        const goalText = await this.mailboxSyncer.readJobGoal(jobId) || '';
        const planText = await this.mailboxSyncer.readJobPlan(jobId);
        const reviewText = await this.mailboxSyncer.readJobReview(jobId);

        if (!planText || !reviewText) {
          logger.warn(`Job ${jobId} missing plan.md or review.md for IMPLEMENT phase`);
          const status: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'IMPLEMENT',
            observedRevision: spec.revision,
            state: 'BLOCKED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            error: 'Missing plan.md or review.md in mailbox for IMPLEMENT phase.',
          };
          await this.mailboxSyncer.writeJobStatus(jobId, status);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark BLOCKED (missing plan.md/review.md)`);
          await this.mailboxTransport.pushWithRetry();
          continue;
        }

        // Mark IMPLEMENTING state
        const impStatus: JobStatus = {
          schemaVersion: 1,
          jobId,
          projectId: spec.projectId,
          observedPhase: 'IMPLEMENT',
          observedRevision: spec.revision,
          state: 'IMPLEMENTING',
          updatedAt: new Date().toISOString(),
          baseSha: spec.baseSha,
          summary: 'Gemini worker is implementing code changes in isolated worktree...',
        };
        await this.mailboxSyncer.writeJobStatus(jobId, impStatus);
        await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): mark IMPLEMENTING`);
        await this.mailboxTransport.pushWithRetry();

        const impWorktree = this.worktreeManager.getImplementWorktreePath(spec.projectId, jobId);
        const workerBranch = this.worktreeManager.getWorkerBranchName(spec.projectId, jobId);
        this.ledger.recordStart(jobId, spec.projectId, 'IMPLEMENT', spec.revision, null, impWorktree, workerBranch);

        // Execute IMPLEMENT worker
        const impRes = await this.implementWorker.execute(
          jobId,
          spec.projectId,
          projConfig,
          spec.baseSha,
          goalText,
          planText,
          reviewText,
          cfg.pushWorkerBranches,
          cfg.mailboxRemote || 'origin',
          spec.timeoutSeconds
        );

        await this.mailboxSyncer.writeJobResult(jobId, impRes.reportText);

        if (impRes.exitCode === 0 && !impRes.error && impRes.bridgeVerificationPassed) {
          this.ledger.recordFinish(jobId, 'IMPLEMENTATION_READY');
          const readyStatus: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'IMPLEMENT',
            observedRevision: spec.revision,
            state: 'IMPLEMENTATION_READY',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            workerBranch: impRes.workerBranch,
            headSha: impRes.headSha,
            exitCode: 0,
            summary: `Implementation completed successfully on ${impRes.workerBranch}. Authoritative Bridge verification passed.`,
          };
          await this.mailboxSyncer.writeJobStatus(jobId, readyStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): publish result.md and mark IMPLEMENTATION_READY`);
          await this.mailboxTransport.pushWithRetry();
          await this.notify('Implementation Ready', `Implementation for ${jobId} is ready on ${impRes.workerBranch}.`);
        } else {
          this.ledger.recordFinish(jobId, 'FAILED');
          const failStatus: JobStatus = {
            schemaVersion: 1,
            jobId,
            projectId: spec.projectId,
            observedPhase: 'IMPLEMENT',
            observedRevision: spec.revision,
            state: 'FAILED',
            updatedAt: new Date().toISOString(),
            baseSha: spec.baseSha,
            workerBranch: impRes.workerBranch,
            headSha: impRes.headSha,
            exitCode: impRes.exitCode,
            error: impRes.error || 'Implementation or verification failed.',
            summary: `Implementation attempt failed (Bridge Verification: ${impRes.bridgeVerificationPassed ? 'PASSED' : 'FAILED'}).`,
          };
          await this.mailboxSyncer.writeJobStatus(jobId, failStatus);
          await this.mailboxTransport.stageAndCommitJobArtifacts(jobId, `worker(${jobId}): publish result.md and mark FAILED`);
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
