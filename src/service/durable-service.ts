import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager, USER_BRIDGE_DIR } from '../config.js';
import { Ledger } from '../engine/ledger.js';
import { ModelSelector } from '../engine/model-selector.js';
import { ProcessManager } from '../engine/process-manager.js';
import { TargetAvailabilityLedger, TargetAvailabilityStore } from '../engine/target-availability-ledger.js';
import { ReadOnlyExecutionKernel, ReadOnlySelectionBlocked } from '../engine/read-only-kernel.js';
import { WorktreeManager } from '../git/worktree.js';
import { AdapterRegistry } from '../worker/adapter-registry.js';
import { buildAdapterRegistry } from '../worker/adapter-factory.js';
import { logger } from '../utils/logger.js';
import { assertPathContained, canonicalizePath } from '../utils/path-authority.js';
import {
  ApproveJobParams,
  ApproveJobResult,
  CancelJobParams,
  CancelJobResult,
  GetJobParams,
  GetJobResult,
  GetResultParams,
  GetResultResult,
  IpcMethod,
  ListTargetsResult,
  PrepareProjectParams,
  PrepareProjectResult,
  StartJobParams,
  StartJobResult,
  TargetQualification,
} from './ipc-protocol.js';
import { IpcServer } from './ipc-server.js';
import { JobManager, StoredJobRecord } from './job-manager.js';
import { TargetAvailabilityRecord, WorkerRole } from '../types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_IPC_STORAGE_PATH = path.join(USER_BRIDGE_DIR, 'ipc-jobs.json');
const CANCEL_AWAIT_TIMEOUT_MS = 15_000;

function projectIdForProjectPath(projectPath: string): string {
  const canonical = canonicalizePath(projectPath);
  const base = path.basename(canonical).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const hash = crypto.createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 8);
  return `ipc-${base}-${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DurableServiceOptions {
  pipePath?: string;
  configManager?: ConfigManager;
  ledger?: Ledger;
  availabilityLedger?: TargetAvailabilityLedger;
  jobManager?: JobManager;
  adapterRegistry?: AdapterRegistry;
  processManager?: ProcessManager;
  storagePath?: string;
  trustedRoots?: string[];
}

export class DurableService {
  private readonly configManager: ConfigManager;
  private readonly ledger: Ledger;
  private readonly availability: TargetAvailabilityStore;
  private readonly registry: AdapterRegistry;
  private readonly modelSelector: ModelSelector;
  private readonly processManager: ProcessManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly kernel: ReadOnlyExecutionKernel;
  private readonly jobManager: JobManager;
  private readonly ipcServer: IpcServer;
  private readonly trustedRoots: string[];
  private readonly queue: string[] = [];
  private processing = false;
  private readonly executionPromises = new Map<string, Promise<void>>();
  private activeJobId: string | undefined;

  constructor(options?: DurableServiceOptions) {
    this.configManager = options?.configManager || new ConfigManager();
    const cfg = this.configManager.getConfig();

    this.ledger = options?.ledger || new Ledger();
    this.availability = options?.availabilityLedger || new TargetAvailabilityLedger();
    this.processManager = options?.processManager || new ProcessManager();
    this.worktreeManager = new WorktreeManager(cfg.workerRootDir);

    this.registry = options?.adapterRegistry || buildAdapterRegistry(cfg, this.processManager);
    this.modelSelector = new ModelSelector(this.registry, cfg, this.availability);
    this.kernel = new ReadOnlyExecutionKernel(this.configManager, {
      adapterRegistry: this.registry,
      availability: this.availability,
      processManager: this.processManager,
      worktreeManager: this.worktreeManager,
      modelSelector: this.modelSelector,
    });

    this.trustedRoots = options?.trustedRoots || [
      process.env.WORKER_BRIDGE_TRUSTED_ROOT || path.resolve(process.env.USERPROFILE || 'C:\\Users\\Xharv', 'Projects'),
    ];

    this.jobManager = options?.jobManager || new JobManager({
      trustedRoots: this.trustedRoots,
      storagePath: options?.storagePath || DEFAULT_IPC_STORAGE_PATH,
    });

    this.ipcServer = new IpcServer({
      pipePath: options?.pipePath,
      onRequest: (method, params, connectionId) => this.handleRequest(method, params, connectionId),
    });
  }

  async start(): Promise<void> {
    await this.ipcServer.start();
    logger.info('Durable Worker Bridge service started successfully.');
  }

  async stop(): Promise<void> {
    if (this.activeJobId) {
      await this.kernel.cancelActiveExecution(this.activeJobId);
    }
    await this.ipcServer.close();
    logger.info('Durable Worker Bridge service stopped.');
  }

  getPipePath(): string {
    return this.ipcServer.getPipePath();
  }

  /** The single ProcessManager authority for this service; adapters and the kernel share it. */
  getProcessManager(): ProcessManager {
    return this.processManager;
  }

  private async handleRequest(
    method: IpcMethod,
    params: Record<string, unknown>,
    connectionId: string
  ): Promise<unknown> {
    switch (method) {
      case 'list_targets':
        return this.listTargets();

      case 'start_job':
        return this.startJob(params as unknown as StartJobParams);

      case 'get_job':
        return this.getJob(params as unknown as GetJobParams);

      case 'get_result':
        return this.getResult(params as unknown as GetResultParams);

      case 'cancel_job':
        return this.cancelJob(params as unknown as CancelJobParams);

      case 'prepare_project':
        return this.prepareProject(params as unknown as PrepareProjectParams);

      case 'approve_job':
        return this.approveJob(params as unknown as ApproveJobParams, connectionId);

      case 'shutdown':
        setTimeout(() => this.stop(), 50);
        return { shuttingDown: true };

      default:
        throw new Error(`UNKNOWN_METHOD: Method "${method}" is not supported.`);
    }
  }

  listTargets(): ListTargetsResult {
    // Materialize cooldown expiry so stale COOLDOWN records surface as
    // ELIGIBLE_TO_RETRY (UNKNOWN) rather than as still-unavailable.
    this.availability.refreshEligibility(new Date());
    const policy = this.modelSelector.getPolicy();
    const targets = Object.values(policy.targets || {}).slice(0, 128);

    // Qualification reflects positive availability evidence, not permission to
    // probe. Eligibility ("may attempt") and qualification ("positive evidence")
    // are separate concepts: an expired cooldown is eligible again but UNKNOWN
    // until a probe or successful execution provides evidence.
    const qualificationFor = (record: TargetAvailabilityRecord | null): TargetQualification => {
      if (!record) return 'UNKNOWN';
      switch (record.state) {
        case 'AVAILABLE':
          return 'KNOWN_AVAILABLE';
        case 'LOW':
          // LOW is a positive-but-degraded provider response: still usable.
          return 'KNOWN_AVAILABLE';
        case 'COOLDOWN':
        case 'EXHAUSTED':
          return 'KNOWN_UNAVAILABLE';
        case 'ELIGIBLE_TO_RETRY':
        case 'UNKNOWN':
          return 'UNKNOWN';
        default:
          return 'UNKNOWN';
      }
    };

    const mapped = targets.map((t) => {
      const record = this.availability.get(t.targetId);
      const qualification = qualificationFor(record);
      return {
        targetId: t.targetId,
        platformId: t.platformId,
        displayName: t.displayName,
        explicitOnly: t.explicitOnly,
        modelBinding: t.modelBinding,
        available: qualification === 'KNOWN_AVAILABLE',
        qualification,
        reasoningStrategy: t.reasoning?.strategy,
      };
    });

    return { targets: mapped };
  }

  startJob(params: StartJobParams): StartJobResult {
    const result = this.jobManager.createJob(params);
    if (result.state === 'PENDING') {
      this.scheduleExecution(result.jobId);
    }
    return result;
  }

  getJob(params: GetJobParams): GetJobResult {
    return this.jobManager.getJob(params.jobId);
  }

  getResult(params: GetResultParams): GetResultResult {
    return this.jobManager.getResult(params.jobId, params.offset, params.limit);
  }

  async cancelJob(params: CancelJobParams): Promise<CancelJobResult> {
    const record = this.jobManager.getJobRecord(params.jobId);
    if (!record) {
      throw new Error(`JOB_NOT_FOUND: Job "${params.jobId}" was not found.`);
    }
    const previousState = record.state;

    // Already-settled terminal states are returned truthfully as-is. A later
    // cancel never rewrites an observed terminal (natural completion, failure,
    // fail-closed interruption, or a previous confirmed cancellation).
    if (previousState !== 'PENDING' && previousState !== 'WORKER_RUNNING') {
      return {
        jobId: record.jobId,
        previousState,
        newState: record.state,
        sourceEffectsPresent: record.sourceEffectsPresent || record.state === 'INTERRUPTED_WITH_SOURCE_STATE',
        recoveryRequired: record.sourceEffectsPresent || record.state === 'INTERRUPTED_WITH_SOURCE_STATE',
      };
    }

    // Queued / not yet started: no worker process exists, so CANCELLED is
    // mechanically truthful without any termination step.
    if (previousState === 'PENDING') {
      const queuedIndex = this.queue.indexOf(params.jobId);
      if (queuedIndex >= 0) {
        this.queue.splice(queuedIndex, 1);
      }
      return this.jobManager.cancelJob(params.jobId);
    }

    // WORKER_RUNNING: request termination FIRST, then let the execution settle
    // within a bounded window, then decide the terminal state from mechanical
    // evidence. CANCELLED is only ever claimed when termination was confirmed.
    const termination = await this.kernel.cancelActiveExecution(params.jobId);
    if (termination !== 'TERMINATED') {
      const promise = this.executionPromises.get(params.jobId);
      if (promise) {
        await Promise.race([promise, sleep(CANCEL_AWAIT_TIMEOUT_MS)]);
      }
      // The worker process may not have existed yet when the first termination
      // attempt ran (the job was still resolving/planning). Re-check: if a
      // process exists now, terminate it and treat the confirmation as valid.
      if (this.jobManager.getJobRecord(params.jobId)?.state === 'WORKER_RUNNING') {
        const recheck = await this.kernel.cancelActiveExecution(params.jobId);
        if (recheck === 'TERMINATED') {
          const confirmed = this.jobManager.confirmCancellation(
            params.jobId,
            'CANCELLED: worker process tree termination was mechanically confirmed.'
          );
          return { ...confirmed, previousState };
        }
      }
    }

    const current = this.jobManager.getJobRecord(params.jobId);
    if (!current) {
      throw new Error(`JOB_NOT_FOUND: Job "${params.jobId}" was not found.`);
    }
    if (current.state === 'WORKER_RETURNED' || current.state === 'FAILED' || current.state === 'BLOCKED') {
      // The worker settled a truthful terminal state while cancellation raced
      // (or a genuine failure landed before/without our termination). Preserve
      // it; only a confirmed termination may convert FAILED into CANCELLED.
      if (current.state === 'FAILED' && termination === 'TERMINATED') {
        const confirmed = this.jobManager.confirmCancellation(
          params.jobId,
          'CANCELLED: worker process tree termination was mechanically confirmed.'
        );
        return { ...confirmed, previousState };
      }
      return {
        jobId: current.jobId,
        previousState,
        newState: current.state,
        sourceEffectsPresent: Boolean(current.sourceEffectsPresent),
        recoveryRequired: Boolean(current.sourceEffectsPresent),
      };
    }
    if (current.state !== 'WORKER_RUNNING') {
      // CANCELLED / INTERRUPTED / INTERRUPTED_WITH_SOURCE_STATE already settled
      // (e.g., a prior cancel or restart reconciliation won the race).
      return {
        jobId: current.jobId,
        previousState,
        newState: current.state,
        sourceEffectsPresent: current.sourceEffectsPresent || current.state === 'INTERRUPTED_WITH_SOURCE_STATE',
        recoveryRequired: current.sourceEffectsPresent || current.state === 'INTERRUPTED_WITH_SOURCE_STATE',
      };
    }

    if (termination === 'TERMINATED') {
      const confirmed = this.jobManager.confirmCancellation(
        params.jobId,
        'CANCELLED: worker process tree termination was mechanically confirmed.'
      );
      return { ...confirmed, previousState };
    }
    this.jobManager.updateJobResult(params.jobId, {
      state: 'INTERRUPTED',
      error:
        termination === 'NO_ACTIVE_PROCESS'
          ? 'CANCELLATION_UNCONFIRMED: no tracked worker process remained to terminate; the job did not settle cleanly.'
          : 'CANCELLATION_UNCONFIRMED: worker process termination could not be mechanically confirmed within the bounded window.',
      completedAt: new Date().toISOString(),
    });
    const interrupted = this.jobManager.getJobRecord(params.jobId);
    return {
      jobId: params.jobId,
      previousState,
      newState: interrupted ? interrupted.state : 'INTERRUPTED',
      sourceEffectsPresent: false,
      recoveryRequired: false,
    };
  }

  private approveJob(params: ApproveJobParams, connectionId: string): ApproveJobResult {
    return this.jobManager.approveJob(params.challenge, `ipc_${connectionId}`);
  }

  private scheduleExecution(jobId: string): void {
    if (this.queue.includes(jobId) || this.executionPromises.has(jobId)) {
      return;
    }
    this.queue.push(jobId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift() as string;
        const record = this.jobManager.getJobRecord(jobId);
        if (!record || record.state !== 'PENDING') {
          continue;
        }
        const promise = this.runJob(record);
        this.executionPromises.set(jobId, promise);
        this.activeJobId = jobId;
        try {
          await promise;
        } finally {
          this.executionPromises.delete(jobId);
          if (this.activeJobId === jobId) {
            this.activeJobId = undefined;
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async runJob(record: StoredJobRecord): Promise<void> {
    const projectId = projectIdForProjectPath(record.projectPath);
    const req = {
      jobId: record.jobId,
      projectId,
      projectPath: record.projectPath,
      intent: record.intent,
      goal: record.goal,
      role: record.role as WorkerRole | undefined,
      baseSha: record.baseSha,
      timeoutSeconds: record.timeoutSeconds,
      workerSelection: record.workerSelection,
      excludedPlatforms: record.excludedPlatforms,
    };

    let resolved;
    try {
      resolved = await this.kernel.resolve(req);
    } catch (err) {
      if (err instanceof ReadOnlySelectionBlocked) {
        this.jobManager.updateJobResult(record.jobId, {
          state: 'BLOCKED',
          error: err.message,
          completedAt: new Date().toISOString(),
        });
        return;
      }
      this.jobManager.updateJobResult(record.jobId, {
        state: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // A cancellation that landed while resolving must prevent any invocation.
    const afterResolve = this.jobManager.getJobRecord(record.jobId);
    if (!afterResolve || afterResolve.state !== 'PENDING') {
      logger.info(`Job ${record.jobId} was cancelled while resolving; worker was not invoked.`);
      return;
    }

    this.jobManager.updateJobResult(record.jobId, {
      state: 'WORKER_RUNNING',
      startedAt: new Date().toISOString(),
      targetId: resolved.selection.targetId,
      platform: resolved.selection.platform,
      model: resolved.selection.modelId,
      reasoning: resolved.selection.variant,
      summary: `Worker on ${resolved.selection.platform} (${resolved.selection.modelId}) is running a read-only ${resolved.role.toLowerCase()} task...`,
    });

    let outcome;
    try {
      outcome = await this.kernel.execute(req, resolved);
    } catch (err) {
      this.recordExecutionFailure(record.jobId, err instanceof Error ? err.message : String(err));
      return;
    }

    const current = this.jobManager.getJobRecord(record.jobId);
    if (!current) {
      return;
    }
    if (
      current.state === 'CANCELLED' ||
      current.state === 'INTERRUPTED' ||
      current.state === 'INTERRUPTED_WITH_SOURCE_STATE'
    ) {
      logger.info(`Job ${record.jobId} was cancelled during execution; terminal state preserved.`);
      return;
    }

    if (outcome.terminalState === 'WORKER_RETURNED') {
      this.jobManager.updateJobResult(record.jobId, {
        state: 'WORKER_RETURNED',
        resultText: outcome.planResult.planText,
        summary: `Worker ${outcome.selectedTarget.targetId} (${outcome.selectedTarget.modelId}) completed the read-only task.`,
        verification: outcome.verification,
        changedFiles: outcome.planResult.mutatedFiles,
        completedAt: new Date().toISOString(),
      });
    } else {
      this.jobManager.updateJobResult(record.jobId, {
        state: 'FAILED',
        error: outcome.planResult.error || outcome.planResult.failureClass || 'PROCESS_FAILED',
        summary: `Worker ${outcome.selectedTarget.targetId} failed the read-only task.`,
        verification: outcome.verification,
        resultText: outcome.planResult.planText || undefined,
        changedFiles: outcome.planResult.mutatedFiles,
        completedAt: new Date().toISOString(),
      });
    }
  }

  private recordExecutionFailure(jobId: string, message: string): void {
    const current = this.jobManager.getJobRecord(jobId);
    if (
      !current ||
      current.state === 'CANCELLED' ||
      current.state === 'INTERRUPTED' ||
      current.state === 'INTERRUPTED_WITH_SOURCE_STATE'
    ) {
      return;
    }
    this.jobManager.updateJobResult(jobId, {
      state: 'FAILED',
      error: message,
      completedAt: new Date().toISOString(),
    });
  }

  private async prepareProject(params: PrepareProjectParams): Promise<PrepareProjectResult> {
    const trustedRoot = this.trustedRoots[0];

    // Case 1: Existing project validation
    if (params.projectPath) {
      const canonical = canonicalizePath(params.projectPath);
      assertPathContained(canonical, this.trustedRoots);

      if (!fs.existsSync(canonical)) {
        throw new Error(`PROJECT_NOT_FOUND: Directory "${canonical}" does not exist.`);
      }

      const gitDir = path.join(canonical, '.git');
      if (!fs.existsSync(gitDir)) {
        throw new Error(`NOT_A_GIT_REPO: Directory "${canonical}" does not contain a git repository.`);
      }

      if (params.syncMode === 'fetch') {
        try {
          await execFileAsync('git', ['-C', canonical, 'fetch', 'origin', '--'], { windowsHide: true });
        } catch (err) {
          logger.warn(`Failed to fetch origin in ${canonical}: ${String(err)}`);
        }
      } else if (params.syncMode === 'fast-forward') {
        const status = await execFileAsync('git', ['-C', canonical, 'status', '--porcelain'], { windowsHide: true });
        if (status.stdout.trim()) {
          throw new Error(`DIRTY_WORKTREE: Cannot fast-forward repository with uncommitted changes in "${canonical}".`);
        }
        try {
          await execFileAsync('git', ['-C', canonical, 'merge', '--ff-only', '@{u}'], { windowsHide: true });
        } catch {
          throw new Error(`SYNC_NOT_FAST_FORWARD: Cannot fast-forward branch in "${canonical}".`);
        }
      }

      const rev = await execFileAsync('git', ['-C', canonical, 'rev-parse', 'HEAD'], { windowsHide: true });
      const branchRes = await execFileAsync('git', ['-C', canonical, 'branch', '--show-current'], { windowsHide: true });
      const statusRes = await execFileAsync('git', ['-C', canonical, 'status', '--porcelain'], { windowsHide: true });

      return {
        projectPath: canonical,
        status: params.syncMode && params.syncMode !== 'none' ? 'synced' : 'ready',
        baseSha: rev.stdout.trim(),
        branch: branchRes.stdout.trim(),
        clean: statusRes.stdout.trim().length === 0,
      };
    }

    // Case 2: Clone new project under trusted root
    if (params.remote && params.destinationName) {
      if (
        params.destinationName.startsWith('-') ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(params.destinationName)
      ) {
        throw new Error(`INVALID_DESTINATION: Destination name "${params.destinationName}" is invalid or starts with hyphen.`);
      }

      const dest = path.join(trustedRoot, params.destinationName);
      if (fs.existsSync(dest)) {
        throw new Error(`DESTINATION_COLLISION: Directory "${dest}" already exists.`);
      }

      if (
        (!params.remote.startsWith('https://') && !params.remote.startsWith('git@')) ||
        params.remote.startsWith('-') ||
        params.remote.includes('\n') ||
        params.remote.includes('\r')
      ) {
        throw new Error(`INVALID_REMOTE: Remote "${params.remote}" must use https:// or git@ protocol without leading hyphens.`);
      }

      if (params.ref) {
        if (
          params.ref.startsWith('-') ||
          !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,127}$/.test(params.ref)
        ) {
          throw new Error(`INVALID_REF: Git ref "${params.ref}" is invalid or starts with hyphen.`);
        }
      }

      await execFileAsync('git', ['clone', '--single-branch', '--', params.remote, dest], { windowsHide: true });

      if (params.ref) {
        await execFileAsync('git', ['-C', dest, 'checkout', params.ref, '--'], { windowsHide: true });
      }

      const rev = await execFileAsync('git', ['-C', dest, 'rev-parse', 'HEAD'], { windowsHide: true });
      const branchRes = await execFileAsync('git', ['-C', dest, 'branch', '--show-current'], { windowsHide: true });

      return {
        projectPath: dest,
        status: 'cloned',
        baseSha: rev.stdout.trim(),
        branch: branchRes.stdout.trim(),
        clean: true,
      };
    }

    throw new Error('INVALID_PARAMS: Either projectPath or (remote and destinationName) must be provided.');
  }
}