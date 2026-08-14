import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Ledger } from '../../src/engine/ledger.js';

describe('Evidence Preservation & Bridge Verification Invariants', () => {
  let tmpLedgerPath: string;
  let tmpWorktreeDir: string;

  beforeEach(() => {
    tmpLedgerPath = path.join(os.tmpdir(), `test-ev-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tmpWorktreeDir = path.join(os.tmpdir(), `test-ev-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    fs.mkdirSync(tmpWorktreeDir, { recursive: true });
    fs.writeFileSync(path.join(tmpWorktreeDir, 'in_progress_work.txt'), 'Evidence content\n');
  });

  afterEach(() => {
    if (fs.existsSync(tmpLedgerPath)) {
      try {
        fs.unlinkSync(tmpLedgerPath);
      } catch {}
    }
    if (fs.existsSync(tmpWorktreeDir)) {
      try {
        fs.rmSync(tmpWorktreeDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('preserves the worktree and artifacts when a job is recovered as INTERRUPTED', () => {
    const ledger = new Ledger(tmpLedgerPath);
    ledger.recordStart('job-interrupted-001', 'ashley', 'IMPLEMENT', 1, 98765, tmpWorktreeDir, 'worker/ashley/job-001');

    // Simulate restart with dead PID
    const recovered = ledger.recoverInterruptedJobs((_pid) => false);

    expect(recovered.length).toBe(1);
    expect(recovered[0].state).toBe('INTERRUPTED');
    expect(recovered[0].worktreePath).toBe(tmpWorktreeDir);

    // Verify physical worktree directory was NOT destroyed
    expect(fs.existsSync(tmpWorktreeDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpWorktreeDir, 'in_progress_work.txt'))).toBe(true);
  });
});
