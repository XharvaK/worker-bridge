import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { WorkerTargetConfig } from '../../src/types.js';

describe('TargetAvailabilityLedger', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const ledgerPath of paths.splice(0)) {
      if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
    }
  });

  it('persists exact target failure evidence and exposes retry eligibility after expiry', () => {
    const ledgerPath = path.join(os.tmpdir(), `availability-${Date.now()}-${Math.random()}.json`);
    paths.push(ledgerPath);
    const ledger = new TargetAvailabilityLedger(ledgerPath);
    const target: WorkerTargetConfig = {
      targetId: 'agy_gemini_flash_37_high',
      platformId: 'antigravity',
      modelId: 'gemini-3.7-flash-high',
      displayName: 'Gemini Flash 3.7 High',
      reasoning: { strategy: 'highest-supported' },
    };

    ledger.recordFailure(
      target,
      'QUOTA_EXHAUSTED',
      '2026-08-14T20:00:00.000Z',
      '2026-08-14T21:00:00.000Z',
      'quota exhausted; retry-after: 3600'
    );

    const reloaded = new TargetAvailabilityLedger(ledgerPath);
    expect(reloaded.get(target.targetId, new Date('2026-08-14T20:30:00.000Z'))).toMatchObject({
      targetId: target.targetId,
      state: 'COOLDOWN',
      retryAt: '2026-08-14T21:00:00.000Z',
      rawEvidence: 'quota exhausted; retry-after: 3600',
    });
    expect(reloaded.get(target.targetId, new Date('2026-08-14T21:00:00.000Z'))?.state).toBe('ELIGIBLE_TO_RETRY');
  });
});
