import { describe, it, expect } from 'vitest';
import { parseJobSpec } from '../../src/mailbox/parser.js';

describe('JobSpec Parser & Schema Validation', () => {
  const validJobV1 = {
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

  const validJobV2 = {
    schemaVersion: 2,
    jobId: 'job-20260814-002',
    projectId: 'ashley',
    baseSha: '9e5c4a17b2f6831d044e1cf6f9202517865c3619',
    intent: 'plan',
    executionMode: 'READ_ONLY',
    round: 1,
    revision: 1,
    role: 'INVESTIGATOR',
    workerSelection: {
      targetId: 'opencode_nemotron_35_lightning',
    },
    recovery: {
      enabled: true,
      fromRound: 1,
    },
    createdAt: '2026-08-14T16:30:00.000Z',
  };

  it('parses a valid v1 job spec', () => {
    const result = parseJobSpec(JSON.stringify(validJobV1));
    expect(result.valid).toBe(true);
    expect(result.spec?.jobId).toBe('job-20260814-001');
    expect(result.spec?.requestedPhase).toBe('PLAN');
  });

  it('parses a valid v2 job spec', () => {
    const result = parseJobSpec(JSON.stringify(validJobV2));
    expect(result.valid).toBe(true);
    expect(result.spec?.jobId).toBe('job-20260814-002');
    expect(result.spec?.intent).toBe('plan');
    expect(result.spec?.executionMode).toBe('READ_ONLY');
    expect(result.spec?.round).toBe(1);
    expect(result.spec?.role).toBe('INVESTIGATOR');
    expect(result.spec?.workerSelection?.targetId).toBe('opencode_nemotron_35_lightning');
    expect(result.spec?.recovery?.enabled).toBe(true);
  });

  it('parses an explicit model selection without reasoning', () => {
    const result = parseJobSpec(JSON.stringify({
      ...validJobV2,
      workerSelection: { platform: 'codex', model: 'gpt-5' },
    }));
    expect(result.valid).toBe(true);
    expect(result.spec?.workerSelection).toEqual({ platform: 'codex', model: 'gpt-5' });
  });

  it('accepts a bounded nonrecursive fallback selection', () => {
    const result = parseJobSpec(JSON.stringify({
      ...validJobV2,
      workerSelection: {
        targetId: 'opencode_nemotron_35_lightning',
        fallbackSelection: { platform: 'codex', model: 'gpt-5' },
      },
    }));
    expect(result.valid).toBe(true);
    expect(result.spec?.workerSelection?.fallbackSelection).toEqual({ platform: 'codex', model: 'gpt-5' });
  });

  it('rejects recursive or capability-bearing fallback selection', () => {
    for (const fallbackSelection of [
      { platform: 'codex', fallbackSelection: { model: 'gpt-5' } },
      { platform: 'codex', allowFallback: true },
      { platform: 42 },
      {},
    ]) {
      const result = parseJobSpec(JSON.stringify({
        ...validJobV2,
        workerSelection: { fallbackSelection },
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('fallbackSelection');
    }
  });

  it('rejects unsupported worker roles', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV2, role: 'AUTOMATIC_FIXER' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('role');
  });

  it('rejects unsupported schema version', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV1, schemaVersion: 99 }));
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
      const res = parseJobSpec(JSON.stringify({ ...validJobV1, jobId: badId }));
      expect(res.valid).toBe(false);
      expect(res.error).toContain('jobId');
    }
  });

  it('rejects invalid commit SHA format', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV1, baseSha: 'invalid-not-hex' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('baseSha');
  });

  it('rejects unsupported phases in v1', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV1, requestedPhase: 'RUN_ARBITRARY_COMMAND' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requestedPhase');
  });

  it('rejects unsupported intents in v2', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV2, intent: 'hack_the_planet' }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('intent');
  });

  it('rejects non-positive revisions', () => {
    const result = parseJobSpec(JSON.stringify({ ...validJobV1, revision: 0 }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('revision');
  });
});
