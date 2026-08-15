import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertPathContained, canonicalizePath } from '../utils/path-authority.js';
import {
  ApproveJobResult,
  CancelJobResult,
  GetJobResult,
  GetResultResult,
  StartJobParams,
  StartJobResult,
} from './ipc-protocol.js';
import { ExecutionMode, JobIntent, JobState, WorkerSelection } from '../types.js';

export interface StoredJobRecord {
  jobId: string;
  clientRequestId: string;
  payloadHash: string;
  projectPath: string;
  intent: JobIntent;
  executionMode: ExecutionMode;
  goal: string;
  plan?: string;
  review?: string;
  workerSelection?: WorkerSelection;
  timeoutSeconds?: number;
  baseSha?: string;
  excludedPlatforms?: string[];
  state: JobState;
  requiresOwnerApproval: boolean;
  approvalChallenge?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalSource?: string;
  resultText?: string;
  summary?: string;
  verification?: string;
  changedFiles?: string[];
  diffStat?: string;
  recoveryStatus?: string;
  sourceEffectsPresent?: boolean;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobManagerOptions {
  trustedRoots?: string[];
  storagePath?: string;
}

const DEFAULT_PAGE_LIMIT = 32 * 1024; // 32 KB
const MAX_PAGE_LIMIT = 64 * 1024; // 64 KB
const DEFAULT_TRUSTED_ROOTS = [
  process.env.WORKER_BRIDGE_TRUSTED_ROOT || path.resolve(process.env.USERPROFILE || 'C:\\Users\\Xharv', 'Projects'),
];

export class JobManager {
  private readonly trustedRoots: string[];
  private readonly storagePath?: string;
  private readonly jobs = new Map<string, StoredJobRecord>();
  private readonly clientRequests = new Map<string, { jobId: string; payloadHash: string }>();
  private readonly challengeToJobId = new Map<string, string>();

  constructor(options?: JobManagerOptions) {
    this.trustedRoots = options?.trustedRoots || DEFAULT_TRUSTED_ROOTS;
    this.storagePath = options?.storagePath;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    let mutated = false;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          // Reconcile in-flight nonterminal state on service restart
          const nonterminalStates: JobState[] = [
            'PENDING',
            'WORKER_REQUESTED',
            'WORKER_RUNNING',
            'PLANNING',
            'IMPLEMENTING',
          ];
          if (nonterminalStates.includes(job.state)) {
            mutated = true;
            job.completedAt = new Date().toISOString();
            if (job.sourceEffectsPresent) {
              job.state = 'INTERRUPTED_WITH_SOURCE_STATE';
              job.recoveryStatus = 'RECOVERY_REQUIRED';
              job.error = 'INTERRUPTED_WITH_SOURCE_STATE: Service restarted while write job was in flight; partial source effects preserved.';
            } else {
              job.state = 'INTERRUPTED';
              job.error = `INTERRUPTED: Service restarted while ${job.executionMode} job was in flight.`;
            }
          }

          this.jobs.set(job.jobId, job);
          if (job.approvalChallenge) {
            this.challengeToJobId.set(job.approvalChallenge, job.jobId);
          }
        }
      }
      if (Array.isArray(data.clientRequests)) {
        for (const req of data.clientRequests) {
          this.clientRequests.set(req.clientRequestId, { jobId: req.jobId, payloadHash: req.payloadHash });
        }
      }
      if (mutated) {
        this.saveToDisk();
      }
    } catch {
      // Corrupt or unreadable ledger
    }
  }

  private saveToDisk(): void {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        jobs: Array.from(this.jobs.values()),
        clientRequests: Array.from(this.clientRequests.entries()).map(([clientRequestId, val]) => ({
          clientRequestId,
          jobId: val.jobId,
          payloadHash: val.payloadHash,
        })),
      };
      const tmpPath = `${this.storagePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.storagePath);
    } catch {
      // Non-fatal disk write error
    }
  }

  private computePayloadHash(params: StartJobParams): string {
    const { clientRequestId, ...rest } = params;
    const normalized = JSON.stringify(rest, Object.keys(rest).sort());
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  createJob(params: StartJobParams): StartJobResult {
    const { clientRequestId, projectPath, intent, executionMode, goal } = params;

    if (!clientRequestId?.trim()) {
      throw new Error('INVALID_PARAMS: clientRequestId is required.');
    }
    if (!projectPath?.trim()) {
      throw new Error('INVALID_PARAMS: projectPath is required.');
    }
    if (!goal?.trim()) {
      throw new Error('INVALID_PARAMS: goal is required.');
    }

    if (executionMode === 'WORKTREE_WRITE') {
      throw new Error(
        'OWNER_AUTHORITY_UNAVAILABLE: WORKTREE_WRITE execution mode is not supported over MCP in v1. MCP is strictly READ_ONLY (plan, investigate, audit, review). Use the GitHub mailbox bridge for owner-authorized WORKTREE_WRITE tasks.'
      );
    }

    const canonicalProject = canonicalizePath(projectPath);
    assertPathContained(canonicalProject, this.trustedRoots);

    const payloadHash = this.computePayloadHash(params);
    const existing = this.clientRequests.get(clientRequestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Error(
          `IDEMPOTENCY_CONFLICT: clientRequestId "${clientRequestId}" was previously submitted with a different payload.`
        );
      }
      const existingJob = this.jobs.get(existing.jobId);
      if (existingJob) {
        return {
          jobId: existingJob.jobId,
          state: existingJob.state,
          executionMode: existingJob.executionMode,
          requiresOwnerApproval: existingJob.requiresOwnerApproval,
          approvalChallenge: existingJob.approvalChallenge,
        };
      }
    }

    const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const requiresOwnerApproval = false;
    const approvalChallenge = undefined;
    const state: JobState = 'PENDING';

    const workerSelection: WorkerSelection | undefined = params.workerSelection
      ? {
          targetId: params.workerSelection.targetId,
          platform: params.workerSelection.platform,
          model: params.workerSelection.model,
          reasoning: typeof params.workerSelection.reasoning === 'string'
            ? { strategy: 'explicit', value: params.workerSelection.reasoning }
            : params.workerSelection.reasoning,
        }
      : undefined;

    const record: StoredJobRecord = {
      jobId,
      clientRequestId,
      payloadHash,
      projectPath: canonicalProject,
      intent,
      executionMode,
      goal,
      plan: params.plan,
      review: params.review,
      workerSelection,
      timeoutSeconds: params.timeoutSeconds,
      baseSha: params.baseSha,
      excludedPlatforms: params.excludedPlatforms,
      state,
      requiresOwnerApproval,
      approvalChallenge,
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, record);
    this.clientRequests.set(clientRequestId, { jobId, payloadHash });
    if (approvalChallenge) {
      this.challengeToJobId.set(approvalChallenge, jobId);
    }
    this.saveToDisk();

    return {
      jobId,
      state,
      executionMode,
      requiresOwnerApproval,
      approvalChallenge,
    };
  }

  getJob(jobId: string): GetJobResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Job "${jobId}" was not found.`);
    }

    const reasoningStr = typeof job.workerSelection?.reasoning === 'object'
      ? (job.workerSelection.reasoning.value || job.workerSelection.reasoning.strategy)
      : (typeof job.workerSelection?.reasoning === 'string' ? job.workerSelection.reasoning : undefined);

    return {
      jobId: job.jobId,
      state: job.state,
      executionMode: job.executionMode,
      intent: job.intent,
      target: job.workerSelection?.targetId,
      platform: job.workerSelection?.platform,
      model: job.workerSelection?.model,
      reasoning: reasoningStr,
      summary: job.summary,
      verification: job.verification,
      changedFiles: job.changedFiles,
      diffStat: job.diffStat,
      recoveryStatus: job.recoveryStatus,
      requiresOwnerApproval: job.requiresOwnerApproval,
      approvalChallenge: job.approvalChallenge,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  getResult(jobId: string, offset = 0, limit = DEFAULT_PAGE_LIMIT): GetResultResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Job "${jobId}" was not found.`);
    }

    const text = job.resultText || '';
    const totalBytes = Buffer.byteLength(text, 'utf8');
    const boundedLimit = Math.min(Math.max(1, limit), MAX_PAGE_LIMIT);
    const textBuffer = Buffer.from(text, 'utf8');
    const slice = textBuffer.subarray(offset, offset + boundedLimit).toString('utf8');
    const hasMore = offset + boundedLimit < totalBytes;

    return {
      jobId: job.jobId,
      state: job.state,
      resultText: slice,
      totalBytes,
      offset,
      limit: boundedLimit,
      hasMore,
    };
  }

  cancelJob(jobId: string): CancelJobResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Job "${jobId}" was not found.`);
    }

    const previousState = job.state;
    if (
      job.state !== 'CANCELLED' &&
      job.state !== 'FAILED' &&
      job.state !== 'WORKER_RETURNED' &&
      job.state !== 'INTERRUPTED_WITH_SOURCE_STATE'
    ) {
      if (job.sourceEffectsPresent) {
        job.state = 'INTERRUPTED_WITH_SOURCE_STATE';
      } else {
        job.state = 'CANCELLED';
      }
      job.completedAt = new Date().toISOString();
      this.saveToDisk();
    }

    const sourceEffectsPresent = job.sourceEffectsPresent || job.state === 'INTERRUPTED_WITH_SOURCE_STATE';
    return {
      jobId: job.jobId,
      previousState,
      newState: job.state,
      sourceEffectsPresent,
      recoveryRequired: sourceEffectsPresent,
    };
  }

  approveJob(challenge: string, source = 'ipc_cli'): ApproveJobResult {
    const jobId = this.challengeToJobId.get(challenge);
    if (!jobId) {
      throw new Error('CHALLENGE_NOT_FOUND: Invalid or expired approval challenge.');
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: Job "${jobId}" was not found.`);
    }

    if (job.state !== 'AWAITING_OWNER') {
      return {
        jobId: job.jobId,
        approved: job.state === 'OWNER_APPROVED' || job.state === 'WORKER_RUNNING' || job.state === 'WORKER_RETURNED',
        state: job.state,
      };
    }

    job.state = 'OWNER_APPROVED';
    job.approvedBy = 'Sol';
    job.approvedAt = new Date().toISOString();
    job.approvalSource = source;
    job.requiresOwnerApproval = false;
    this.saveToDisk();

    return {
      jobId: job.jobId,
      approved: true,
      state: job.state,
    };
  }

  updateJobResult(
    jobId: string,
    update: Partial<StoredJobRecord>
  ): void {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, update);
      this.saveToDisk();
    }
  }
}
