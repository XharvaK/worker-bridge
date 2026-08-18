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
import { ExecutionMode, JobIntent, JobState, LegacyWorkerRole, OrchestratorInfo, WorkerRole, WorkerSelection } from '../types.js';
import { roleForJob } from '../engine/job-role.js';

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
  originSurface?: string;
  role?: LegacyWorkerRole | string;
  orchestrator?: OrchestratorInfo;
  state: JobState;
  requiresOwnerApproval: boolean;
  approvalChallenge?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalSource?: string;
  targetId?: string;
  platform?: string;
  model?: string;
  reasoning?: string;
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

// A byte position is a valid UTF-8 code-point boundary when it is the start of
// the buffer, the end of the buffer, or the first byte of a code point (that
// is, not a continuation byte 10xxxxxx).
function isUtf8CodePointBoundary(buffer: Buffer, offset: number): boolean {
  if (offset <= 0 || offset >= buffer.length) {
    return true;
  }
  return (buffer[offset] & 0xc0) !== 0x80;
}
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
            if (job.role === 'PLANNER') {
              job.state = 'FAILED';
              job.error = 'UNSUPPORTED_LEGACY_ROLE: In-flight jobs with legacy PLANNER role fail closed in v2.';
            } else if (job.sourceEffectsPresent) {
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

    if ((params.role as any) === 'PLANNER') {
      throw new Error('INVALID_ROLE: Role "PLANNER" is not a selectable Worker Bridge role. Expected INVESTIGATOR, WORKER, or REVIEWER.');
    }

    const requestedPlat = params.workerSelection?.platform?.toLowerCase();
    const requestedTarget = params.workerSelection?.targetId?.toLowerCase();
    if (requestedPlat === 'cursor-agent' || requestedTarget === 'cursor-agent') {
      throw new Error('RECURSION_BLOCKED: Platform "cursor-agent" is not a valid downstream worker target.');
    }

    const effectiveRole = roleForJob(intent, params.role);

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
      originSurface: params.originSurface,
      role: effectiveRole,
      orchestrator: params.orchestrator,
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

  getJobRecord(jobId: string): StoredJobRecord | undefined {
    return this.jobs.get(jobId);
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
      target: job.targetId || job.workerSelection?.targetId,
      platform: job.platform || job.workerSelection?.platform,
      model: job.model || job.workerSelection?.model,
      reasoning: job.reasoning || reasoningStr,
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
    const textBuffer = Buffer.from(text, 'utf8');
    const totalBytes = textBuffer.length;
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
    const requestedOffset = Math.max(0, Math.floor(offset));

    // offset must land on a complete UTF-8 code-point boundary. Callers that
    // follow the returned nextOffset can never produce an invalid offset.
    if (requestedOffset > totalBytes || !isUtf8CodePointBoundary(textBuffer, requestedOffset)) {
      const err = new Error(
        `INVALID_RESULT_OFFSET: Offset ${requestedOffset} is not at a UTF-8 code-point boundary within 0..${totalBytes}. Use nextOffset from the previous page.`,
      );
      (err as any).code = 'INVALID_RESULT_OFFSET';
      throw err;
    }

    // Byte budget; pull the end boundary backward until it lands on a complete
    // code point so resultText never contains U+FFFD replacement characters.
    let end = Math.min(requestedOffset + boundedLimit, totalBytes);
    while (end > requestedOffset && !isUtf8CodePointBoundary(textBuffer, end)) {
      end -= 1;
    }
    // A budget smaller than a single code point must still make forward
    // progress: extend to the next complete code point so nextOffset > offset.
    if (end === requestedOffset && requestedOffset < totalBytes) {
      end = requestedOffset + 1;
      while (end < totalBytes && !isUtf8CodePointBoundary(textBuffer, end)) {
        end += 1;
      }
    }

    const slice = textBuffer.subarray(requestedOffset, end).toString('utf8');

    return {
      jobId: job.jobId,
      state: job.state,
      resultText: slice,
      totalBytes,
      offset: requestedOffset,
      limit: boundedLimit,
      nextOffset: end,
      hasMore: end < totalBytes,
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
