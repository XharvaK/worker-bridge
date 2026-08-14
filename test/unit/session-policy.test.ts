import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Ledger } from '../../src/engine/ledger.js';
import { ModelSelector, ResolvedWorkerSelection } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
  WorkerSessionIdentity,
} from '../../src/types.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

class SessionPolicyAdapter implements WorkerAdapter {
  constructor(
    readonly platformId: string,
    readonly supportsCrossModelSessionContinuation = false,
  ) {}

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return {
      platformId: this.platformId,
      displayName: this.platformId,
      installed: true,
      executablePath: `fixture-${this.platformId}`,
    };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [];
  }

  async resolveReasoningProfile(): Promise<string | undefined> {
    return undefined;
  }

  async probeQuota(): Promise<QuotaProbeResult> {
    return { state: 'UNKNOWN' };
  }

  async invokeWorker(_request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    throw new Error('Session policy tests must not invoke a worker.');
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

function sessionSelection(overrides: Partial<ResolvedWorkerSelection> = {}): ResolvedWorkerSelection {
  return {
    targetId: 'target-session',
    platform: 'fixture',
    modelId: 'fixture-model',
    variant: 'max',
    reasoningStrategy: 'explicit',
    ...overrides,
  };
}

function sessionIdentity(overrides: Partial<WorkerSessionIdentity> = {}): WorkerSessionIdentity {
  return {
    targetId: 'target-session',
    platform: 'fixture',
    model: 'fixture-model',
    reasoning: 'max',
    sessionId: 'session-001',
    worktreeCwd: 'C:\\workers\\session-001',
    executionMode: 'READ_ONLY',
    ...overrides,
  };
}

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

  it('continues only when target, model, native reasoning, session, worktree, and mode match', () => {
    const registry = new AdapterRegistry();
    registry.register(new SessionPolicyAdapter('fixture'));
    const selector = new ModelSelector(registry);
    const previous = sessionIdentity();

    expect(selector.canContinueSession(previous, sessionSelection(), 'READ_ONLY', previous.worktreeCwd)).toBe(true);
    expect(selector.canContinueSession(previous, sessionSelection({ variant: 'high' }), 'READ_ONLY', previous.worktreeCwd)).toBe(false);
    expect(selector.canContinueSession(previous, sessionSelection(), 'WORKTREE_WRITE', previous.worktreeCwd)).toBe(false);
    expect(selector.canContinueSession(previous, sessionSelection(), 'READ_ONLY', 'C:\\workers\\other')).toBe(false);
  });

  it('fails closed when the exact prior session ID is unavailable', () => {
    const registry = new AdapterRegistry();
    registry.register(new SessionPolicyAdapter('fixture'));
    const selector = new ModelSelector(registry);

    expect(
      selector.canContinueSession(
        sessionIdentity({ sessionId: undefined }),
        sessionSelection(),
        'READ_ONLY',
        'C:\\workers\\session-001',
      ),
    ).toBe(false);
  });

  it('fails closed when native reasoning, target, or current worktree identity is unavailable', () => {
    const registry = new AdapterRegistry();
    registry.register(new SessionPolicyAdapter('fixture'));
    const selector = new ModelSelector(registry);
    const previous = sessionIdentity();

    expect(selector.canContinueSession({ ...previous, reasoning: undefined }, sessionSelection(), 'READ_ONLY', previous.worktreeCwd)).toBe(false);
    expect(selector.canContinueSession({ ...previous, targetId: undefined }, sessionSelection(), 'READ_ONLY', previous.worktreeCwd)).toBe(false);
    expect(selector.canContinueSession(previous, sessionSelection(), 'READ_ONLY')).toBe(false);
  });

  it('refuses Codex same-platform model changes without adapter capability', () => {
    const registry = new AdapterRegistry();
    registry.register(new SessionPolicyAdapter('codex', false));
    const selector = new ModelSelector(registry);

    expect(
      selector.canContinueSession(
        sessionIdentity({ targetId: 'codex-explicit', platform: 'codex', model: 'gpt-5.6-sol', worktreeCwd: 'C:\\workers\\codex' }),
        sessionSelection({ targetId: 'codex-explicit', platform: 'codex', modelId: 'gpt-5.6-terra' }),
        'READ_ONLY',
        'C:\\workers\\codex',
      ),
    ).toBe(false);
  });
});
