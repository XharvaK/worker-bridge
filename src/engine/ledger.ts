import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutionMode, JobIntent, JobPhase, JobState, LedgerData, LedgerJobRecord, WorkJob, WorkerRole } from '../types.js';
import { USER_BRIDGE_DIR } from '../config.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_LEDGER_PATH = path.join(USER_BRIDGE_DIR, 'ledger.json');

export class Ledger {
  private ledgerPath: string;
  private data: LedgerData;

  constructor(customPath?: string) {
    this.ledgerPath = customPath ? path.resolve(customPath) : DEFAULT_LEDGER_PATH;
    this.data = { version: 2, jobs: {} };
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const content = fs.readFileSync(this.ledgerPath, 'utf8');
        const parsed = JSON.parse(content) as Partial<LedgerData>;
        this.data = {
          version: parsed.version || 2,
          jobs: parsed.jobs || {},
        };
      } else {
        const dir = path.dirname(this.ledgerPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.data = { version: 2, jobs: {} };
        this.save();
      }
    } catch (err) {
      logger.error(`Failed to load ledger from ${this.ledgerPath}: ${String(err)}`);
      this.data = { version: 2, jobs: {} };
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.ledgerPath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.ledgerPath);
    } catch (err) {
      logger.error(`Failed to save ledger to ${this.ledgerPath}: ${String(err)}`);
    }
  }

  getJobRecord(jobId: string): LedgerJobRecord | null {
    return this.data.jobs[jobId] || null;
  }

  shouldExecute(jobSpec: WorkJob): boolean {
    const record = this.data.jobs[jobSpec.jobId];
    if (!record) {
      // New job never seen in ledger
      return true;
    }

    const currentRound = jobSpec.round || 1;
    const recordRound = record.lastHandledRound || 1;
    const mode = jobSpec.executionMode || (jobSpec.requestedPhase === 'IMPLEMENT' ? 'WORKTREE_WRITE' : 'READ_ONLY');
    const intent = jobSpec.intent || (jobSpec.requestedPhase === 'IMPLEMENT' ? 'implement' : 'plan');

    // If new round submitted, execute new round
    if (currentRound > recordRound) {
      return true;
    }

    // If same round but higher revision submitted
    if (currentRound === recordRound && jobSpec.revision > record.lastHandledRevision) {
      return true;
    }

    // If CANCEL requested
    if (jobSpec.requestedPhase === 'CANCEL') {
      return record.state !== 'CANCELLED';
    }

    // If requestedPhase changed in v1 mode
    if (jobSpec.requestedPhase && record.lastHandledPhase && jobSpec.requestedPhase !== record.lastHandledPhase) {
      return true;
    }

    // If executionMode or intent changed
    if (
      currentRound === recordRound &&
      jobSpec.revision === record.lastHandledRevision &&
      (mode !== record.lastHandledMode || intent !== record.lastHandledIntent)
    ) {
      return true;
    }

    // Terminal states -> Do not execute again (Idempotency guarantee)
    const terminalStates: JobState[] = [
      'PLAN_READY',
      'IMPLEMENTATION_READY',
      'WORKER_RETURNED',
      'SOL_REVIEWED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'INTERRUPTED',
      'INTERRUPTED_WITH_SOURCE_STATE',
    ];

    if (terminalStates.includes(record.state)) {
      return false;
    }

    // In-flight state (PLANNING, IMPLEMENTING, WORKER_RUNNING) -> Already executing
    return false;
  }

  recordStart(
    jobId: string,
    projectId: string,
    modeOrPhase: ExecutionMode | JobPhase,
    arg4: any,
    arg5?: any,
    arg6?: any,
    arg7?: any,
    arg8?: any,
    arg9?: any,
    arg10?: any,
    arg11?: any,
    arg12?: any,
    arg13?: any,
    arg14?: any,
    arg15?: any,
    arg16?: any,
    arg17?: any
  ): LedgerJobRecord {
    let mode: ExecutionMode = 'READ_ONLY';
    let intent: JobIntent = 'plan';
    let round = 1;
    let revision = 1;
    let pid: number | null = null;
    let platform: string | undefined;
    let model: string | undefined;
    let worktreePath: string | null = null;
    let workerBranch: string | null = null;
    let sessionId: string | null = null;
    let targetId: string | undefined;
    let role: WorkerRole | undefined;
    let sourceEffectsPresent = false;
    let recoveryCapsulePath: string | null = null;
    let currentHeadSha: string | null = null;

    if (typeof arg4 === 'number' && (typeof arg5 === 'number' || arg5 === null || arg5 === undefined)) {
      // Legacy signature: (jobId, projectId, phase, revision, pid, worktreePath?, workerBranch?)
      const phase = modeOrPhase as JobPhase;
      mode = phase === 'IMPLEMENT' ? 'WORKTREE_WRITE' : 'READ_ONLY';
      intent = phase === 'IMPLEMENT' ? 'implement' : 'plan';
      round = 1;
      revision = arg4;
      pid = arg5 ?? null;
      worktreePath = arg6 || null;
      workerBranch = arg7 || null;
    } else {
      // V2 signature: (jobId, projectId, mode, intent, round, revision, pid, platform?, model?, worktreePath?, workerBranch?, sessionId?)
      mode = modeOrPhase as ExecutionMode;
      intent = arg4 as JobIntent;
      round = arg5 as number;
      revision = arg6 as number;
      pid = arg7 ?? null;
      platform = arg8;
      model = arg9;
      worktreePath = arg10 || null;
      workerBranch = arg11 || null;
      sessionId = arg12 || null;
      targetId = arg13 || undefined;
      role = arg14 || undefined;
      sourceEffectsPresent = arg15 === true;
      recoveryCapsulePath = arg16 || null;
      currentHeadSha = arg17 || null;
    }

    const state: JobState =
      mode === 'READ_ONLY' ? 'PLANNING' : mode === 'WORKTREE_WRITE' ? 'IMPLEMENTING' : 'WORKER_RUNNING';
    const phase: JobPhase = mode === 'READ_ONLY' ? 'PLAN' : 'IMPLEMENT';

    const record: LedgerJobRecord = {
      jobId,
      projectId,
      lastHandledRound: round,
      lastHandledRevision: revision,
      lastHandledMode: mode,
      lastHandledIntent: intent,
      lastHandledPhase: phase,
      platform,
      model,
      targetId,
      role,
      platformSessionId: sessionId || null,
      state,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastKnownPid: pid,
      worktreePath: worktreePath || null,
      workerBranch: workerBranch || null,
      sourceEffectsPresent,
      recoveryCapsulePath,
      currentHeadSha,
    };
    this.data.jobs[jobId] = record;
    this.save();
    return record;
  }

  recordFinish(
    jobId: string,
    state: JobState,
    sessionId?: string | null,
    finishedAt?: string
  ): LedgerJobRecord | null {
    const record = this.data.jobs[jobId];
    if (!record) return null;

    record.state = state;
    if (sessionId) {
      record.platformSessionId = sessionId;
    }
    record.finishedAt = finishedAt || new Date().toISOString();
    record.lastKnownPid = null;
    this.save();
    return record;
  }

  updateJobEvidence(
    jobId: string,
    patch: Partial<Pick<LedgerJobRecord, 'targetId' | 'role' | 'sourceEffectsPresent' | 'worktreePath' | 'workerBranch' | 'recoveryCapsulePath' | 'currentHeadSha'>>
  ): LedgerJobRecord | null {
    const record = this.data.jobs[jobId];
    if (!record) return null;
    Object.assign(record, patch);
    this.save();
    return record;
  }

  recoverInterruptedJobs(isPidAliveFn: (pid: number) => boolean): LedgerJobRecord[] {
    const recovered: LedgerJobRecord[] = [];
    for (const record of Object.values(this.data.jobs)) {
      if (
        record.state === 'PLANNING' ||
        record.state === 'IMPLEMENTING' ||
        record.state === 'WORKER_RUNNING'
      ) {
        const isAlive = record.lastKnownPid ? isPidAliveFn(record.lastKnownPid) : false;
        if (!isAlive) {
          logger.warn(
            `Recovering interrupted job ${record.jobId} (was ${record.state}, PID ${record.lastKnownPid} is dead)`
          );
          record.state = record.sourceEffectsPresent ? 'INTERRUPTED_WITH_SOURCE_STATE' : 'INTERRUPTED';
          record.finishedAt = new Date().toISOString();
          record.lastKnownPid = null;
          recovered.push(record);
        }
      }
    }
    if (recovered.length > 0) {
      this.save();
    }
    return recovered;
  }
}
