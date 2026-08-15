import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Ledger } from '../../src/engine/ledger.js';
import { JobSpec } from '../../src/types.js';

describe('Ledger (Persistent Idempotency & Crash Recovery)', () => {
  let tmpLedgerPath: string;

  beforeEach(() => {
    tmpLedgerPath = path.join(os.tmpdir(), `test-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpLedgerPath)) {
      fs.unlinkSync(tmpLedgerPath);
    }
  });

  it('allows execution for new unseen jobs', () => {
    const ledger = new Ledger(tmpLedgerPath);
    const spec: JobSpec = {
      schemaVersion: 1,
      jobId: 'job-001',
      projectId: 'ashley',
      baseSha: 'abcdef123456',
      requestedPhase: 'PLAN',
      revision: 1,
      createdAt: new Date().toISOString(),
    };

    expect(ledger.shouldExecute(spec)).toBe(true);
  });

  it('prevents duplicate execution of completed jobs with same revision and phase', () => {
    const ledger = new Ledger(tmpLedgerPath);
    const spec: JobSpec = {
      schemaVersion: 1,
      jobId: 'job-001',
      projectId: 'ashley',
      baseSha: 'abcdef123456',
      requestedPhase: 'PLAN',
      revision: 1,
      createdAt: new Date().toISOString(),
    };

    ledger.recordStart('job-001', 'ashley', 'PLAN', 1, 1234);
    ledger.recordFinish('job-001', 'PLAN_READY');

    // Polling again should be a NO-OP
    expect(ledger.shouldExecute(spec)).toBe(false);
  });

  it('allows execution when revision is incremented for next phase', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart('job-001', 'ashley', 'PLAN', 1, 1234);
    ledger.recordFinish('job-001', 'PLAN_READY');

    const implementSpec: JobSpec = {
      schemaVersion: 1,
      jobId: 'job-001',
      projectId: 'ashley',
      baseSha: 'abcdef123456',
      requestedPhase: 'IMPLEMENT',
      revision: 2,
      createdAt: new Date().toISOString(),
    };

    expect(ledger.shouldExecute(implementSpec)).toBe(true);
  });

  it('recovers interrupted jobs on bridge restart', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart('job-interrupted', 'ashley', 'IMPLEMENT', 1, 99999);

    // Simulate restart with PID dead
    const isPidAlive = (_pid: number) => false;
    const recovered = ledger.recoverInterruptedJobs(isPidAlive);

    expect(recovered.length).toBe(1);
    expect(recovered[0].jobId).toBe('job-interrupted');
    expect(recovered[0].state).toBe('INTERRUPTED');

    // Reload ledger from disk and verify persistence
    const reloaded = new Ledger(tmpLedgerPath);
    const record = reloaded.getJobRecord('job-interrupted');
    expect(record?.state).toBe('INTERRUPTED');
  });

  it('persists the resolved native reasoning with the session identity', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart(
      'job-native-reasoning',
      'ashley',
      'READ_ONLY',
      'plan',
      2,
      1,
      null,
      'codex',
      'gpt-5.6-sol',
      'C:\\workers\\job-native-reasoning',
      null,
      'codex-session-001',
      'codex_explicit',
      'PLANNER',
      false,
      null,
      'abcdef1234567890',
      'max',
    );

    expect(ledger.getJobRecord('job-native-reasoning')).toMatchObject({
      platform: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'max',
      platformSessionId: 'codex-session-001',
      worktreePath: 'C:\\workers\\job-native-reasoning',
      lastHandledMode: 'READ_ONLY',
    });
    expect(new Ledger(tmpLedgerPath).getJobRecord('job-native-reasoning')?.reasoning).toBe('max');
  });

  it('keeps completed historical PLANNER records readable for audit', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart(
      'job-legacy-planner-audit',
      'ashley',
      'READ_ONLY',
      'plan',
      1,
      1,
      null,
      'antigravity',
      'gemini-3.7-flash-high',
      'C:\\workers\\job-legacy-planner-audit',
      null,
      null,
      'agy_gemini_flash_37_high',
      'PLANNER',
      false,
      null,
      'abcdef1234567890',
      'high'
    );
    ledger.recordFinish('job-legacy-planner-audit', 'PLAN_READY');

    const reloaded = new Ledger(tmpLedgerPath);
    const record = reloaded.getJobRecord('job-legacy-planner-audit');
    expect(record).not.toBeNull();
    expect(record?.role).toBe('PLANNER');
    expect(record?.state).toBe('PLAN_READY');
  });

  it('fails closed when an in-flight nonterminal PLANNER record is encountered on startup reconciliation', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart(
      'job-in-flight-legacy-planner',
      'ashley',
      'READ_ONLY',
      'plan',
      1,
      1,
      null,
      'antigravity',
      'gemini-3.7-flash-high',
      'C:\\workers\\job-in-flight-legacy-planner',
      null,
      null,
      'agy_gemini_flash_37_high',
      'PLANNER',
      false,
      null,
      'abcdef1234567890',
      'high'
    );

    // Reconcile on startup: in-flight PLANNER job must fail closed to FAILED, not converted to INVESTIGATOR
    const isPidAlive = (_pid: number) => false;
    const recovered = ledger.recoverInterruptedJobs(isPidAlive);

    expect(recovered.length).toBe(1);
    expect(recovered[0].jobId).toBe('job-in-flight-legacy-planner');
    expect(recovered[0].state).toBe('FAILED');
    expect(recovered[0].role).toBe('PLANNER');
  });
});
