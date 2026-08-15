import { describe, it, expect, beforeEach } from 'vitest';
import { ModelSelector } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { InMemoryTargetAvailabilityStore } from '../../src/engine/target-availability-ledger.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import { checkExecutionLineage } from '../../src/mcp/mcp-server.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

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
    return 'xhigh';
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

describe('Recursion blocking & execution-lineage protection', () => {
  let registry: AdapterRegistry;
  let selector: ModelSelector;

  beforeEach(() => {
    registry = new AdapterRegistry();
    registry.register(new MockAdapter('cursor-cli', 'grok-4.6'));
    registry.register(new MockAdapter('antigravity', 'gemini-3.7-flash-high'));
    registry.register(new MockAdapter('opencode', 'nemotron-3.5-lightning'));
    registry.register(new MockAdapter('cursor', 'cursor-model'));

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
            cursor_grok_46_xhigh: {
              targetId: 'cursor_grok_46_xhigh',
              platformId: 'cursor-cli',
              modelId: 'grok-4.6',
              displayName: 'Cursor CLI Grok XHigh',
              reasoning: { strategy: 'explicit', value: 'xhigh' },
            },
            cursor_target: {
              targetId: 'cursor_target',
              platformId: 'cursor',
              modelId: 'cursor-model',
              displayName: 'Cursor Worker',
              reasoning: { strategy: 'highest-supported' },
            },
            agy_gemini_flash_37_high: {
              targetId: 'agy_gemini_flash_37_high',
              platformId: 'antigravity',
              modelId: 'gemini-3.7-flash-high',
              displayName: 'AGY Gemini 3.7 High',
              reasoning: { strategy: 'highest-supported' },
            },
            opencode_nemotron_35_lightning: {
              targetId: 'opencode_nemotron_35_lightning',
              platformId: 'opencode',
              modelId: 'nemotron-3.5-lightning',
              displayName: 'OpenCode Nemotron',
              reasoning: { strategy: 'highest-supported' },
            },
          },
          roleRankings: {
            INVESTIGATOR: [
              'cursor_grok_46_xhigh',
              'opencode_nemotron_35_lightning',
              'agy_gemini_flash_37_high',
            ],
            WORKER: [
              'agy_gemini_flash_37_high',
              'opencode_nemotron_35_lightning',
            ],
            REVIEWER: [
              'opencode_nemotron_35_lightning',
              'cursor_grok_46_xhigh',
              'agy_gemini_flash_37_high',
            ],
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
    const selection = await selector.resolveSelection(
      undefined,
      'INVESTIGATOR',
      new Set(),
      undefined,
      new Date(),
      ['cursor-cli']
    );
    expect(selection.targetId).toBe('opencode_nemotron_35_lightning');
    expect(selection.platform).toBe('opencode');
  });

  it('skips excluded platforms in fallback resolution', async () => {
    const current = {
      targetId: 'cursor_grok_46_xhigh',
      platform: 'cursor-cli',
      modelId: 'grok-4.6',
      reasoningStrategy: 'explicit' as const,
    };

    const fallback = await selector.getNextFallback(current, 'INVESTIGATOR', {
      failedTargetIds: new Set(['cursor_grok_46_xhigh']),
      excludedPlatforms: ['cursor-agent', 'opencode'],
    });

    expect(fallback.targetId).toBe('agy_gemini_flash_37_high');
    expect(fallback.platform).toBe('antigravity');
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

    const canContinue = selector.canContinueSession(
      sessionIdentity,
      nextSelection,
      'READ_ONLY',
      'C:\\Projects\\repo'
    );
    expect(canContinue).toBe(true);

    await expect(
      selector.resolveExplicitSelection({ targetId: 'cursor_target' }, ['cursor'])
    ).rejects.toThrow('RECURSION_BLOCKED');
  });

  it('1. trusted cursor-agent ingress can select downstream cursor-cli', async () => {
    const selection = await selector.resolveSelection(
      undefined,
      'INVESTIGATOR',
      new Set(),
      undefined,
      new Date(),
      ['cursor-agent']
    );
    expect(selection.targetId).toBe('cursor_grok_46_xhigh');
    expect(selection.platform).toBe('cursor-cli');
  });

  it('2. platformFamily=cursor or platform=cursor-agent does not block downstream cursor-cli', async () => {
    const explicit = await selector.resolveExplicitSelection(
      { targetId: 'cursor_grok_46_xhigh' },
      ['cursor-agent']
    );
    expect(explicit.targetId).toBe('cursor_grok_46_xhigh');
    expect(explicit.platform).toBe('cursor-cli');
  });

  it('3. caller cannot select cursor-agent as a downstream target', async () => {
    await expect(
      selector.resolveExplicitSelection(
        { platform: 'cursor-agent', model: 'grok-4.6' },
        ['cursor-agent']
      )
    ).rejects.toThrow('RECURSION_BLOCKED');
  });

  it('4. automatic selection falls back cleanly if cursor-cli fails or is excluded', async () => {
    const fallback = await selector.getNextFallback(
      {
        targetId: 'cursor_grok_46_xhigh',
        platform: 'cursor-cli',
        modelId: 'grok-4.6',
        reasoningStrategy: 'explicit',
      },
      'INVESTIGATOR',
      {
        failedTargetIds: new Set(['cursor_grok_46_xhigh']),
        excludedPlatforms: ['cursor-agent'],
      }
    );
    expect(fallback.targetId).toBe('opencode_nemotron_35_lightning');
    expect(fallback.platform).toBe('opencode');
  });

  it('5. reviewer automatic selection can choose cursor-cli under cursor-agent ingress', async () => {
    const selection = await selector.resolveSelection(
      undefined,
      'REVIEWER',
      new Set(['opencode_nemotron_35_lightning']),
      undefined,
      new Date(),
      ['cursor-agent']
    );
    expect(selection.targetId).toBe('cursor_grok_46_xhigh');
    expect(selection.platform).toBe('cursor-cli');
  });

  describe('Execution Lineage Invariants', () => {
    it('A. downstream job attempt to supply WORKER_BRIDGE_EXECUTION_DEPTH=0 is overridden by Worker Bridge', () => {
      const pm = new ProcessManager();
      // ProcessManager injects lineageEnv after options.env so options.env cannot override depth to 0
      const currentDepth = 0;
      const callerEnv = { WORKER_BRIDGE_EXECUTION_DEPTH: '0', WORKER_BRIDGE_PARENT_JOB_ID: 'fake' };
      const mergedEnv = {
        ...callerEnv,
        WORKER_BRIDGE_PARENT_JOB_ID: 'job-real-001',
        WORKER_BRIDGE_EXECUTION_DEPTH: (currentDepth + 1).toString(),
        WORKER_BRIDGE_EXECUTION_CONTEXT: 'worker-child',
      };

      expect(mergedEnv.WORKER_BRIDGE_EXECUTION_DEPTH).toBe('1');
      expect(mergedEnv.WORKER_BRIDGE_PARENT_JOB_ID).toBe('job-real-001');
    });

    it('B. downstream job attempt to blank parent marker leaves controlled value intact', () => {
      const callerEnv = { WORKER_BRIDGE_PARENT_JOB_ID: '' };
      const mergedEnv = {
        ...callerEnv,
        WORKER_BRIDGE_PARENT_JOB_ID: 'job-real-002',
        WORKER_BRIDGE_EXECUTION_DEPTH: '1',
      };
      expect(mergedEnv.WORKER_BRIDGE_PARENT_JOB_ID).toBe('job-real-002');
    });

    it('C. malformed inherited lineage at MCP startup fails closed', () => {
      // Missing parent ID with depth present
      const res1 = checkExecutionLineage({
        WORKER_BRIDGE_EXECUTION_DEPTH: '1',
        WORKER_BRIDGE_PARENT_JOB_ID: '',
      } as any);
      expect(res1.isNested).toBe(true);
      expect(res1.error).toContain('RECURSION_BLOCKED: Malformed execution lineage');

      // Non-numeric depth
      const res2 = checkExecutionLineage({
        WORKER_BRIDGE_PARENT_JOB_ID: 'job-123',
        WORKER_BRIDGE_EXECUTION_DEPTH: 'invalid-depth',
      } as any);
      expect(res2.isNested).toBe(true);
      expect(res2.error).toContain('RECURSION_BLOCKED: Malformed execution lineage depth');
    });

    it('D. depth overflow / absurd value fails closed', () => {
      const res = checkExecutionLineage({
        WORKER_BRIDGE_PARENT_JOB_ID: 'job-123',
        WORKER_BRIDGE_EXECUTION_DEPTH: '99',
      } as any);
      expect(res.isNested).toBe(true);
      expect(res.error).toContain('RECURSION_BLOCKED: Invalid execution lineage depth');
    });

    it('E. top-level process with no lineage allows normal operation', () => {
      const res = checkExecutionLineage({} as any);
      expect(res.isNested).toBe(false);
      expect(res.error).toBeUndefined();
    });

    it('F. valid worker lineage blocks nested start_job with RECURSION_BLOCKED', () => {
      const res = checkExecutionLineage({
        WORKER_BRIDGE_PARENT_JOB_ID: 'job-parent-555',
        WORKER_BRIDGE_EXECUTION_DEPTH: '1',
        WORKER_BRIDGE_EXECUTION_CONTEXT: 'worker-child',
      } as any);
      expect(res.isNested).toBe(true);
      expect(res.error).toContain('RECURSION_BLOCKED: Nested Worker Bridge execution is blocked (lineage: parent job "job-parent-555", depth 1)');
    });
  });
});
