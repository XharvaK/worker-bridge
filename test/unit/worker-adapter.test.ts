import { describe, it, expect } from 'vitest';
import { analyzeOperationalError } from '../../src/worker/worker-adapter.js';

describe('Worker adapter operational failure analysis', () => {
  it('classifies quota exhaustion and converts an authoritative retry-after duration', () => {
    const result = analyzeOperationalError(
      1,
      '',
      'provider: quota exhausted; retry-after: 812 seconds',
      false,
      '2026-08-14T20:00:00.000Z'
    );

    expect(result.failureClass).toBe('QUOTA_EXHAUSTED');
    expect(result.retryAt).toBe('2026-08-14T20:13:32.000Z');
  });

  it('accepts an authoritative reset timestamp and does not invent one otherwise', () => {
    const reset = analyzeOperationalError(
      1,
      '',
      'RESOURCE_EXHAUSTED; reset_at: 2026-08-14T21:42:00.000Z',
      false,
      '2026-08-14T20:00:00.000Z'
    );
    expect(reset.failureClass).toBe('RATE_LIMITED');
    expect(reset.retryAt).toBe('2026-08-14T21:42:00.000Z');

    const noTimer = analyzeOperationalError(1, '', 'quota exhausted; please try later', false, '2026-08-14T20:00:00.000Z');
    expect(noTimer.failureClass).toBe('QUOTA_EXHAUSTED');
    expect(noTimer.retryAt).toBeUndefined();
  });

  it('bounds and sanitizes raw provider evidence', () => {
    const result = analyzeOperationalError(
      1,
      '',
      `quota exhausted\nAuthorization: Bearer ${'x'.repeat(80)}\n${'e'.repeat(10000)}`,
      false,
      '2026-08-14T20:00:00.000Z'
    );

    expect(result.rawEvidence?.length).toBeLessThanOrEqual(4000);
    expect(result.rawEvidence).not.toContain('Bearer ' + 'x'.repeat(80));
  });
});
