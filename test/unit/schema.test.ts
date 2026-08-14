import { describe, it, expect } from 'vitest';
import { parseJobSpec } from '../../src/mailbox/parser.js';

describe('JobSpec Parser & Schema Validation', () => {
  const validJob = {
    schemaVersion: 1,
    jobId: 'job-20260814-001',
    projectId: 'ashley',
    baseSha: '9e5c4a17b2f6831d044e1cf6f9202517865c3619',
    requestedPhase: 'PLAN',
    revision: 1,
    createdAt: '2026-08-14T16:30:00.000Z',
    targetBranch: 'master',
    timeoutSeconds: 900,
  };

  it('parses a valid job spec', () => {
    const result = parseJobSpec(JSON.stringify(validJob));
    expect(result.valid).toBe(true);
    expect(result.spec?.jobId).toBe('job-20260814-001');
    expect(result.spec?.requestedPhase).toBe('PLAN');
  });

  it('rejects unsupported schema version', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJob, schemaVersion: 2 }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('schemaVersion');
  });

  it('rejects path traversal attempts in jobId', () => {
    const malicious = [
      '../../etc/passwd',
      'job/../../hack',
      'job\\..\\hack',
      'job*invalid',
      'ab', // too short
      'a'.repeat(65), // too long
    ];

    for (const badId of malicious) {
      const res = parseJobSpec(JSON.stringify({ ...validJob, jobId: badId }));
      expect(res.valid).toBe(false);
      expect(res.error).toContain('jobId');
    }
  });

  it('rejects invalid commit SHA format', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJob, baseSha: 'invalid-not-hex' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('baseSha');
  });

  it('rejects unsupported phases', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJob, requestedPhase: 'RUN_ARBITRARY_COMMAND' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requestedPhase');
  });

  it('rejects non-positive revisions', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJob, revision: 0 }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('revision');
  });
});
