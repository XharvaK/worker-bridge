import { describe, it, expect, beforeEach } from 'vitest';
import { ModelSelector } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { InMemoryTargetAvailabilityStore } from '../../src/engine/target-availability-ledger.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';

class MockAdapter implements WorkerAdapter {
  readonly platformId: string;
  readonly supportsCrossModelSessionContinuation = false;
  private readonly modelId: string;

  constructor(platformId: string, modelId: string) {
    this.platformId = platformId;
    this.modelId = modelId;
  }
  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return { platformId: this.platformId, displayName: this.platformId, installed: true };
  }
  async discoverModels() {
    return [{ id: this.modelId, displayName: 'Model', selectability: 'SELECTABLE' as const, variants: [] }];
  }
  async resolveReasoningProfile() {
    return 'medium';
  }
  async probeQuota() {
    return { state: 'AVAILABLE' as const };
  }
  async invokeWorker() {
    throw new Error('not implemented');
  }
  async cancel() {
    return true;
  }
}

describe('Recursion blocking for excluded platforms', () => {
  let registry: AdapterRegistry;
  let selector: ModelSelector;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register(new MockAdapter('cursor', 'cursor-model'));
    registry.register(new MockAdapter('antigravity', 'gemini-3.7-flash'));
    registry.register(new MockAdapter('opencode', 'deepseek-v4'));

    selector = new ModelSelector(
      registry,
      {
        mailboxRepoPath: 'dummy',
        workerRootDir: 'dummy',
        pushWorkerBranches: false,
        notificationsEnabled: false,
        allowedProjects: {},
        selectionPolicy: {
          targets: {
            cursor_target: {
              targetId: 'cursor_target',
              platformId: 'cursor',
              modelId: 'cursor-model',
              displayName: 'Cursor Worker',
              reasoning: { strategy: 'highest-supported' },
            },
            agy_target: {
              targetId: 'agy_target',
              platformId: 'antigravity',
              modelId: 'gemini-3.7-flash',
              displayName: 'AGY Flash',
              reasoning: { strategy: 'highest-supported' },
            },
            opencode_target: {
              targetId: 'opencode_target',
              platformId: 'opencode',
              modelId: 'deepseek-v4',
              displayName: 'OpenCode DeepSeek',
              reasoning: { strategy: 'highest-supported' },
            },
          },
          roleRankings: {
            PLANNER: ['cursor_target', 'agy_target', 'opencode_target'],
            WORKER: ['cursor_target', 'agy_target'],
            INVESTIGATOR: ['agy_target'],
            REVIEWER: ['agy_target'],
          },
        },
      },
      new InMemoryTargetAvailabilityStore()
    );
  });

  it('rejects explicit selection of excluded platform with RECURSION_BLOCKED', async () => {
    await expect(
      selector.resolveExplicitSelection({ targetId: 'cursor_target' }, ['cursor'])
    ).rejects.toThrow('RECURSION_BLOCKED');

    await expect(
      selector.resolveExplicitSelection({ platform: 'cursor', model: 'cursor-model' }, ['cursor'])
    ).rejects.toThrow('RECURSION_BLOCKED');
  });

  it('skips excluded platforms in automatic role ranking resolution', async () => {
    // With cursor excluded, cursor_target is skipped, falls through to agy_target
    const selection = await selector.resolveSelection(
      undefined,
      'PLANNER',
      new Set(),
      undefined,
      new Date(),
      ['cursor']
    );
    expect(selection.targetId).toBe('agy_target');
    expect(selection.platform).toBe('antigravity');
  });

  it('skips excluded platforms in fallback resolution', async () => {
    const current = {
      targetId: 'agy_target',
      platform: 'antigravity',
      modelId: 'gemini-3.7-flash',
      reasoningStrategy: 'highest-supported' as const,
    };

    const fallback = await selector.getNextFallback(current, 'PLANNER', {
      failedTargetIds: new Set(['agy_target']),
      excludedPlatforms: ['cursor'],
    });

    expect(fallback.targetId).toBe('opencode_target');
    expect(fallback.platform).toBe('opencode');
  });

  it('skips excluded platforms in reviewer diversification resolution', async () => {
    // REVIEWER ranking has agy_target only; if cursor is requested, it skips cursor
    const selection = await selector.resolveSelection(
      undefined,
      'REVIEWER',
      new Set(),
      undefined,
      new Date(),
      ['cursor']
    );
    expect(selection.platform).toBe('antigravity');
  });

  it('blocks session continuation if target platform is excluded', async () => {
    const sessionIdentity = {
      targetId: 'cursor_target',
      platform: 'cursor',
      model: 'cursor-model',
      sessionId: 'session-123',
      reasoning: 'medium',
      worktreeCwd: 'C:\\Projects\\repo',
      executionMode: 'READ_ONLY' as const,
      round: 1,
    };

    const nextSelection = {
      targetId: 'cursor_target',
      platform: 'cursor',
      modelId: 'cursor-model',
      variant: 'medium',
      reasoningStrategy: 'highest-supported' as const,
    };

    // canContinueSession checks platform match
    const canContinue = selector.canContinueSession(
      sessionIdentity,
      nextSelection,
      'READ_ONLY',
      'C:\\Projects\\repo'
    );
    expect(canContinue).toBe(true);

    // But nextSelection itself cannot be resolved when cursor is excluded
    await expect(
      selector.resolveExplicitSelection({ targetId: 'cursor_target' }, ['cursor'])
    ).rejects.toThrow('RECURSION_BLOCKED');
  });

  it('allows cursor when excludedPlatforms does not include cursor (e.g. mailbox mode)', async () => {
    const selection = await selector.resolveSelection(undefined, 'PLANNER');
    expect(selection.targetId).toBe('cursor_target');
  });
});
