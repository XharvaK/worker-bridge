import { describe, it, expect } from 'vitest';
import { parseJobSpec } from '../../src/mailbox/parser.js';

describe('Owner Approval Gate Invariants', () => {
  it('authorizes READ_ONLY mode execution directly from initial dispatch without separate approval record', () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      jobId: 'job-plan-001',
      projectId: 'ashley',
      baseSha: '9e5c4a17b2f6831d044e1cf6f9202517865c3619',
      intent: 'plan',
      executionMode: 'READ_ONLY',
      round: 1,
      revision: 1,
    });

    const parsed = parseJobSpec(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.spec?.executionMode).toBe('READ_ONLY');
    expect(parsed.spec?.ownerApproval).toBeUndefined();
  });

  it('parses approved WORKTREE_WRITE execution contract with recorded owner approval', () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      jobId: 'job-imp-001',
      projectId: 'ashley',
      baseSha: '9e5c4a17b2f6831d044e1cf6f9202517865c3619',
      intent: 'implement',
      executionMode: 'WORKTREE_WRITE',
      round: 2,
      revision: 1,
      ownerApproval: {
        approved: true,
        approvedBy: 'Doc',
        approvedAt: '2026-08-14T18:00:00Z',
        notes: 'Implementation plan and corrections approved.',
      },
    });

    const parsed = parseJobSpec(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.spec?.executionMode).toBe('WORKTREE_WRITE');
    expect(parsed.spec?.ownerApproval?.approved).toBe(true);
  });
});
