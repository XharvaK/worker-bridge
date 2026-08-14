import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JobPhase, JobSpec, JobState, LedgerData, LedgerJobRecord } from '../types.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_LEDGER_PATH = path.join(os.homedir(), '.gemini-worker-bridge', 'ledger.json');

export class Ledger {
  private ledgerPath: string;
  private data: LedgerData;

  constructor(customPath?: string) {
    this.ledgerPath = customPath ? path.resolve(customPath) : DEFAULT_LEDGER_PATH;
    this.data = { version: 1, jobs: {} };
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const content = fs.readFileSync(this.ledgerPath, 'utf8');
        const parsed = JSON.parse(content) as Partial<LedgerData>;
        this.data = {
          version: parsed.version || 1,
          jobs: parsed.jobs || {},
        };
      } else {
        const dir = path.dirname(this.ledgerPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.data = { version: 1, jobs: {} };
        this.save();
      }
    } catch (err) {
      logger.error(`Failed to load ledger from ${this.ledgerPath}: ${String(err)}`);
      this.data = { version: 1, jobs: {} };
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

  shouldExecute(jobSpec: JobSpec): boolean {
    const record = this.data.jobs[jobSpec.jobId];
    if (!record) {
      // New job never seen in ledger
      return true;
    }

    // If new revision submitted, execute new revision
    if (jobSpec.revision > record.lastHandledRevision) {
      return true;
    }

    // If same revision but requested phase changed (e.g. CANCEL)
    if (jobSpec.revision === record.lastHandledRevision && jobSpec.requestedPhase !== record.lastHandledPhase) {
      return true;
    }

    // Same revision and same phase:
    // Terminal states -> Do not execute again (Idempotency guarantee)
    const terminalStates: JobState[] = [
      'PLAN_READY',
      'IMPLEMENTATION_READY',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'INTERRUPTED',
    ];

    if (terminalStates.includes(record.state)) {
      return false;
    }

    // In-flight state (PLANNING, IMPLEMENTING) -> Already executing
    return false;
  }

  recordStart(
    jobId: string,
    projectId: string,
    phase: JobPhase,
    revision: number,
    pid: number | null,
    worktreePath?: string | null,
    workerBranch?: string | null
  ): LedgerJobRecord {
    const state: JobState = phase === 'PLAN' ? 'PLANNING' : phase === 'IMPLEMENT' ? 'IMPLEMENTING' : 'CANCELLED';
    const record: LedgerJobRecord = {
      jobId,
      projectId,
      lastHandledRevision: revision,
      lastHandledPhase: phase,
      state,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastKnownPid: pid,
      worktreePath: worktreePath || null,
      workerBranch: workerBranch || null,
    };
    this.data.jobs[jobId] = record;
    this.save();
    return record;
  }

  recordFinish(jobId: string, state: JobState, finishedAt?: string): LedgerJobRecord | null {
    const record = this.data.jobs[jobId];
    if (!record) return null;

    record.state = state;
    record.finishedAt = finishedAt || new Date().toISOString();
    record.lastKnownPid = null;
    this.save();
    return record;
  }

  recoverInterruptedJobs(isPidAliveFn: (pid: number) => boolean): LedgerJobRecord[] {
    const recovered: LedgerJobRecord[] = [];
    for (const record of Object.values(this.data.jobs)) {
      if (record.state === 'PLANNING' || record.state === 'IMPLEMENTING') {
        const isAlive = record.lastKnownPid ? isPidAliveFn(record.lastKnownPid) : false;
        if (!isAlive) {
          logger.warn(`Recovering interrupted job ${record.jobId} (was ${record.state}, PID ${record.lastKnownPid} is dead)`);
          record.state = 'INTERRUPTED';
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
