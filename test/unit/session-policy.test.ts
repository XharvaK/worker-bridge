import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Ledger } from '../../src/engine/ledger.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('Session Policy & Cross-Platform Handoff Invariants', () => {
  let tmpLedgerPath: string;

  beforeEach(() => {
    tmpLedgerPath = path.join(os.tmpdir(), `test-sess-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpLedgerPath)) {
      try {
        fs.unlinkSync(tmpLedgerPath);
      } catch {}
    }
  });

  it('preserves and tracks platformSessionId in ledger across rounds', () => {
    const ledger = new Ledger(tmpLedgerPath);

    ledger.recordStart(
      'job-sess-001',
      'ashley',
      'READ_ONLY',
      'plan',
      1,
      1,
      null,
      'opencode',
      'opencode/deepseek-v4-flash-free',
      null,
      null,
      'sess-opencode-abc-123'
    );
    ledger.recordFinish('job-sess-001', 'WORKER_RETURNED', 'sess-opencode-abc-123');

    const record = ledger.getJobRecord('job-sess-001');
    expect(record?.platformSessionId).toBe('sess-opencode-abc-123');
    expect(record?.platform).toBe('opencode');
  });
});
