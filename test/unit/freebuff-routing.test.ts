import { describe, it, expect, vi } from 'vitest';
import { ModelSelector } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { FreebuffAdapter } from '../../src/worker/freebuff-adapter.js';
import { InMemoryTargetAvailabilityStore } from '../../src/engine/target-availability-ledger.js';
import { getDefaultSelectionPolicy } from '../../src/config.js';
import { WorkerAdapter, WorkerAdapterError } from '../../src/worker/worker-adapter.js';

function createMockAdapter(platformId: string, installed = true): WorkerAdapter {
  return {
    platformId,
    supportsCrossModelSessionContinuation: false,
    inspectEnvironment: async () => ({
      platformId,
      displayName: platformId,
      installed,
      version: '1.0.0',
      executablePath: platformId,
    }),
    discoverModels: async () => [
      { id: `${platformId}-model`, displayName: `${platformId} Model`, variants: ['high'], selectability: 'SELECTABLE' },
      { id: 'opencode/nemotron-3.5-lightning-free', displayName: 'Nemotron 3.5 Lightning Free', variants: [], selectability: 'SELECTABLE' },
      { id: 'opencode/deepseek-v4-flash-free', displayName: 'DeepSeek V4 Flash Free', variants: ['max'], selectability: 'SELECTABLE' },
      { id: 'opencode/hy3-free', displayName: 'Hy3 Free', variants: ['high'], selectability: 'SELECTABLE' },
      { id: 'opencode/laguna-s-2.1-free', displayName: 'Laguna S 2.1 Free', variants: ['high'], selectability: 'SELECTABLE' },
      { id: 'opencode/nemotron-3-ultra-free', displayName: 'Nemotron 3 Ultra Free', variants: [], selectability: 'SELECTABLE' },
      { id: 'gpt-5.6-luna', displayName: 'Luna Max', variants: ['max'], selectability: 'SELECTABLE' },
      { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash High', variants: ['high'], selectability: 'SELECTABLE' },
      { id: 'cursor-grok-4.6-medium', displayName: 'Cursor Grok 4.6 Medium', variants: [], selectability: 'SELECTABLE' },
      { id: 'cursor-grok-4.6-xhigh', displayName: 'Cursor Grok 4.6 XHigh', variants: [], selectability: 'SELECTABLE' },
    ],
    resolveReasoningProfile: async () => 'high',
    probeQuota: async () => ({ state: 'AVAILABLE' }),
    invokeWorker: async () => ({
      platformId,
      modelId: `${platformId}-model`,
      exitCode: 0,
      responseText: 'Success',
      artifactsCreated: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
    cancel: async () => true,
  };
}

describe('Freebuff Policy & Routing Integration', () => {
  it('registers freebuff_default target with PROVIDER_MANAGED binding and provider-managed reasoning strategy', () => {
    const policy = getDefaultSelectionPolicy();
    const target = policy.targets.freebuff_default;

    expect(target).toBeDefined();
    expect(target.targetId).toBe('freebuff_default');
    expect(target.platformId).toBe('freebuff');
    expect(target.displayName).toBe('Freebuff (provider-managed default)');
    expect(target.modelBinding).toBe('PROVIDER_MANAGED');
    expect(target.reasoning.strategy).toBe('provider-managed');
    expect(target.aliases).toContain('freebuff_default');
    expect(target.aliases).toContain('freebuff');
  });

  it('places freebuff_default at WORKER rank #4 between cursor_grok_46_medium (#3) and opencode_nemotron_35_lightning (#5)', () => {
    const policy = getDefaultSelectionPolicy();
    const workerRanking = policy.roleRankings.WORKER || [];

    expect(workerRanking).toContain('freebuff_default');
    const index = workerRanking.indexOf('freebuff_default');
    expect(index).toBe(3); // Rank #4 (0-indexed 3)

    expect(workerRanking[0]).toBe('codex_luna_max');
    expect(workerRanking[1]).toBe('agy_gemini_flash_37_high');
    expect(workerRanking[2]).toBe('cursor_grok_46_medium');
    expect(workerRanking[3]).toBe('freebuff_default');
    expect(workerRanking[4]).toBe('opencode_nemotron_35_lightning');
  });

  it('strictly excludes freebuff_default from INVESTIGATOR and REVIEWER rankings', () => {
    const policy = getDefaultSelectionPolicy();
    const investigatorRanking = policy.roleRankings.INVESTIGATOR || [];
    const reviewerRanking = policy.roleRankings.REVIEWER || [];

    expect(investigatorRanking).not.toContain('freebuff_default');
    expect(reviewerRanking).not.toContain('freebuff_default');
  });

  it('automatically skips freebuff_default when probeQuota returns AUTOMATION_SEAM_UNAVAILABLE and falls through to #5 opencode', async () => {
    const registry = new AdapterRegistry();
    registry.register(createMockAdapter('codex'));
    registry.register(createMockAdapter('antigravity'));
    registry.register(createMockAdapter('cursor-cli'));
    registry.register(createMockAdapter('opencode'));

    const freebuffAdapter = new FreebuffAdapter();
    vi.spyOn(freebuffAdapter, 'inspectEnvironment').mockResolvedValue({
      platformId: 'freebuff',
      displayName: 'Freebuff',
      installed: true,
      version: '0.0.149',
      executablePath: 'freebuff',
    });
    registry.register(freebuffAdapter);

    const availability = new InMemoryTargetAvailabilityStore();
    const selector = new ModelSelector(registry, undefined, availability);

    // Simulate targets #1, #2, #3 failing so selector reaches #4
    const excludedFailed = new Set(['codex_luna_max', 'agy_gemini_flash_37_high', 'cursor_grok_46_medium']);

    const resolved = await selector.resolveSelection(
      undefined,
      'WORKER',
      excludedFailed
    );

    // Freebuff probe fails with AUTOMATION_SEAM_UNAVAILABLE, so selector records failure and resolves to rank #5 OpenCode Nemotron 3.5
    expect(resolved.targetId).toBe('opencode_nemotron_35_lightning');
    expect(resolved.platform).toBe('opencode');

    // Verify freebuff_default was recorded as unavailable in the availability store
    const freebuffRecord = availability.get('freebuff_default');
    expect(freebuffRecord).toBeDefined();
    // The bounded re-qualification horizon makes this a COOLDOWN, never a
    // permanent EXHAUSTED suppression.
    expect(freebuffRecord?.state).toBe('COOLDOWN');
    expect(freebuffRecord?.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
    expect(freebuffRecord?.retryAt).toBeDefined();
  });

  it('re-qualifies freebuff after the cooldown window instead of permanently suppressing it', async () => {
    const registry = new AdapterRegistry();
    registry.register(createMockAdapter('codex'));
    registry.register(createMockAdapter('antigravity'));
    registry.register(createMockAdapter('cursor-cli'));
    registry.register(createMockAdapter('opencode'));

    const freebuffAdapter = new FreebuffAdapter();
    vi.spyOn(freebuffAdapter, 'inspectEnvironment').mockResolvedValue({
      platformId: 'freebuff',
      displayName: 'Freebuff',
      installed: true,
      version: '0.0.149',
      executablePath: 'freebuff',
    });
    const probeSpy = vi.spyOn(freebuffAdapter, 'probeQuota');
    registry.register(freebuffAdapter);

    const availability = new InMemoryTargetAvailabilityStore();
    const selector = new ModelSelector(registry, undefined, availability);
    const excludedFailed = new Set(['codex_luna_max', 'agy_gemini_flash_37_high', 'cursor_grok_46_medium']);

    // First ranking attempt: freebuff fails qualification and enters COOLDOWN.
    const first = await selector.resolveSelection(undefined, 'WORKER', excludedFailed);
    expect(first.targetId).toBe('opencode_nemotron_35_lightning');
    expect(probeSpy).toHaveBeenCalledTimes(1);

    const record = availability.get('freebuff_default');
    expect(record?.state).toBe('COOLDOWN');
    const retryAt = Date.parse(record!.retryAt!);

    // Inside the cooldown window the target is skipped without re-probing.
    await selector.resolveSelection(undefined, 'WORKER', excludedFailed, undefined, new Date(retryAt - 1));
    expect(probeSpy).toHaveBeenCalledTimes(1);

    // After the window the target is mechanically re-qualified via a fresh probe.
    const later = await selector.resolveSelection(undefined, 'WORKER', excludedFailed, undefined, new Date(retryAt + 1));
    expect(later.targetId).toBe('opencode_nemotron_35_lightning');
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it('explicit selection of freebuff_default surfaces AUTOMATION_SEAM_UNAVAILABLE and does not claim executability', async () => {
    const registry = new AdapterRegistry();
    const freebuffAdapter = new FreebuffAdapter();
    vi.spyOn(freebuffAdapter, 'inspectEnvironment').mockResolvedValue({
      platformId: 'freebuff',
      displayName: 'Freebuff',
      installed: true,
      version: '0.0.149',
      executablePath: 'freebuff',
    });
    registry.register(freebuffAdapter);

    const selector = new ModelSelector(registry);

    try {
      await selector.resolveExplicitSelection({ targetId: 'freebuff_default' });
      expect.unreachable('Explicit selection of freebuff_default should fail when seam is unavailable');
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkerAdapterError);
      expect(err.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
      expect(err.message).toContain('AUTOMATION_SEAM_UNAVAILABLE');
    }
  });

  it('explicit selection by platform freebuff also surfaces AUTOMATION_SEAM_UNAVAILABLE', async () => {
    const registry = new AdapterRegistry();
    const freebuffAdapter = new FreebuffAdapter();
    vi.spyOn(freebuffAdapter, 'inspectEnvironment').mockResolvedValue({
      platformId: 'freebuff',
      displayName: 'Freebuff',
      installed: true,
      version: '0.0.149',
      executablePath: 'freebuff',
    });
    registry.register(freebuffAdapter);

    const selector = new ModelSelector(registry);

    try {
      await selector.resolveExplicitSelection({ platform: 'freebuff' });
      expect.unreachable('Explicit selection of platform freebuff should fail when seam is unavailable');
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkerAdapterError);
      expect(err.failureClass).toBe('AUTOMATION_SEAM_UNAVAILABLE');
    }
  });

  it('READ_ONLY intent dispatch never resolves to Freebuff', async () => {
    const registry = new AdapterRegistry();
    registry.register(createMockAdapter('cursor-cli'));
    registry.register(createMockAdapter('opencode'));
    registry.register(createMockAdapter('antigravity'));
    registry.register(new FreebuffAdapter());

    const selector = new ModelSelector(registry);
    const resolved = await selector.resolveSelection(undefined, 'plan');

    expect(resolved.platform).not.toBe('freebuff');
    expect(resolved.targetId).not.toBe('freebuff_default');
  });
});
