import { describe, it, expect } from 'vitest';
import { ModelSelector, ResolvedWorkerSelection } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import { validateConfig } from '../../src/config.js';
import {
  DiscoveredModel,
  DiscoveredReasoningProfile,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
  WorkerTargetConfig,
} from '../../src/types.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

class FakeAdapter implements WorkerAdapter {
  readonly platformId: string;
  readonly supportsCrossModelSessionContinuation: boolean;
  private readonly models: DiscoveredModel[];
  private readonly quotaState: QuotaProbeResult;
  quotaProbeCount = 0;

  constructor(
    platformId: string,
    models: Array<string | DiscoveredModel>,
    quotaState: QuotaProbeResult = { state: 'UNKNOWN' },
    supportsCrossModelSessionContinuation = false
  ) {
    this.platformId = platformId;
    this.supportsCrossModelSessionContinuation = supportsCrossModelSessionContinuation;
    this.models = models.map((model) => typeof model === 'string' ? {
      id: model,
      displayName: model,
      variants: ['high', 'xhigh', 'medium', 'max'],
      highestVariant: 'max',
      selectability: 'SELECTABLE',
      reasoningProfiles: [
        { value: 'low', topology: 'ORDINARY' as const },
        { value: 'medium', topology: 'ORDINARY' as const },
        { value: 'high', topology: 'ORDINARY' as const },
        { value: 'xhigh', topology: 'ORDINARY' as const },
        { value: 'max', topology: 'ORDINARY' as const },
      ],
    } : model);
    this.quotaState = quotaState;
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    return {
      platformId: this.platformId,
      displayName: this.platformId,
      installed: true,
      executablePath: `fake-${this.platformId}`,
    };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return this.models;
  }

  async resolveReasoningProfile(
    modelId: string,
    strategy: 'highest-supported' | 'explicit' = 'highest-supported',
    explicitValue?: string
  ): Promise<string | undefined> {
    const model = this.models.find((m) => m.id === modelId);
    if (strategy === 'explicit') {
      if (model?.reasoningProfiles) {
        const found = model.reasoningProfiles.find((p) => p.value === explicitValue);
        if (!found) throw new Error(`REASONING_PROFILE_UNSUPPORTED: ${explicitValue}`);
      }
      return explicitValue;
    }
    return 'max';
  }

  async probeQuota(): Promise<QuotaProbeResult> {
    this.quotaProbeCount++;
    return this.quotaState;
  }

  async invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    const now = new Date().toISOString();
    return {
      platformId: this.platformId,
      modelId: request.modelId,
      variant: request.variant,
      exitCode: 0,
      responseText: 'fake response',
      artifactsCreated: [],
      startedAt: now,
      completedAt: now,
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

function target(targetId: string, platformId: string, modelId: string, reasoning?: { strategy: 'highest-supported' | 'explicit'; value?: string }): WorkerTargetConfig {
  return {
    targetId,
    platformId,
    modelId,
    displayName: targetId,
    aliases: [targetId],
    reasoning: reasoning || { strategy: 'highest-supported' },
  };
}

function makeConfig(targets: Record<string, WorkerTargetConfig>, roleRankings: Record<string, string[]>) {
  return validateConfig({
    mailboxRepoPath: 'C:\\test\\mailbox',
    workerRootDir: 'C:\\test\\workers',
    pushWorkerBranches: false,
    notificationsEnabled: false,
    allowedProjects: {},
    selectionPolicy: {
      targets,
      roleRankings,
      allowFallbackByDefault: true,
      maxFallbackAttempts: 3,
      reviewerPreferDifferentTarget: true,
    },
  });
}

describe('ModelSelector & target policy invariants', () => {
  it('loads each role ordering from configuration data', async () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
      target_b: target('target_b', 'fake-b', 'b-model'),
      target_c: target('target_c', 'fake-a', 'c-model'),
    };
    const config = makeConfig(targets, {
      INVESTIGATOR: ['target_c'],
      WORKER: ['target_a'],
      REVIEWER: ['target_b', 'target_a'],
    });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model', 'c-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config);

    expect((await selector.resolveSelection(undefined, 'INVESTIGATOR')).targetId).toBe('target_c');
    expect((await selector.resolveSelection(undefined, 'WORKER')).targetId).toBe('target_a');
    expect((await selector.resolveSelection(undefined, 'REVIEWER')).targetId).toBe('target_b');
  });

  it('rejects selection with legacy PLANNER role', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });
    const registry = new AdapterRegistry();
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection(undefined, 'PLANNER' as any)).rejects.toThrow(
      'INVALID_ROLE: Role "PLANNER" is not a selectable Worker Bridge role.'
    );
  });

  it('verifies exact locked candidate ordering for INVESTIGATOR, WORKER, and REVIEWER in default policy', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });

    // 1. INVESTIGATOR ranking
    expect(config.selectionPolicy?.roleRankings.INVESTIGATOR).toEqual([
      'cursor_grok_46_xhigh',
      'opencode_nemotron_35_lightning',
      'opencode_deepseek_v4_flash_max',
      'agy_gemini_flash_37_high',
      'opencode_hy3_high',
      'opencode_laguna_s_21_high',
      'opencode_nemotron_3_ultra',
    ]);

    // 2. WORKER ranking (Codex Luna Max priority 1)
    expect(config.selectionPolicy?.roleRankings.WORKER).toEqual([
      'codex_luna_max',
      'agy_gemini_flash_37_high',
      'cursor_grok_46_medium',
      'opencode_nemotron_35_lightning',
      'opencode_deepseek_v4_flash_max',
      'opencode_hy3_high',
      'opencode_laguna_s_21_high',
      'opencode_nemotron_3_ultra',
    ]);

    // 3. REVIEWER ranking
    expect(config.selectionPolicy?.roleRankings.REVIEWER).toEqual([
      'opencode_nemotron_35_lightning',
      'cursor_grok_46_xhigh',
      'agy_gemini_flash_37_high',
      'opencode_hy3_high',
      'opencode_deepseek_v4_flash_max',
      'opencode_nemotron_3_ultra',
      'opencode_laguna_s_21_high',
    ]);
  });

  it('resolves the exact effective primaries for INVESTIGATOR, WORKER, and REVIEWER when available', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('cursor-cli', ['cursor-grok-4.6-xhigh', 'cursor-grok-4.6-medium']));
    registry.register(new FakeAdapter('codex', ['gpt-5.6-luna']));
    registry.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high']));
    registry.register(new FakeAdapter('opencode', ['opencode/nemotron-3.5-lightning-free', 'opencode/deepseek-v4-flash-free']));
    const selector = new ModelSelector(registry, config);

    // 1. Effective INVESTIGATOR primary -> Cursor Grok XHigh
    const investigator = await selector.resolveSelection(undefined, 'INVESTIGATOR');
    expect(investigator.targetId).toBe('cursor_grok_46_xhigh');
    expect(investigator.platform).toBe('cursor-cli');
    expect(investigator.modelId).toBe('cursor-grok-4.6-xhigh');

    // 2. Effective WORKER primary -> Codex Luna Max
    const worker = await selector.resolveSelection(undefined, 'WORKER');
    expect(worker.targetId).toBe('codex_luna_max');
    expect(worker.platform).toBe('codex');
    expect(worker.modelId).toBe('gpt-5.6-luna');
    expect(worker.variant).toBe('max');

    // 3. Effective REVIEWER primary -> OpenCode Nemotron 3.5 Lightning
    const reviewer = await selector.resolveSelection(undefined, 'REVIEWER');
    expect(reviewer.targetId).toBe('opencode_nemotron_35_lightning');
    expect(reviewer.platform).toBe('opencode');
    expect(reviewer.modelId).toBe('opencode/nemotron-3.5-lightning-free');
  });

  it('selects codex_luna_max only when gpt-5.6-luna exists and max reasoning is supported', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });

    // Case 1: gpt-5.6-luna with only high reasoning (no max) -> codex_luna_max not eligible, falls through to AGY
    const registryWithoutMax = new AdapterRegistry();
    registryWithoutMax.register(new FakeAdapter('codex', [{
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      variants: ['high'],
      selectability: 'SELECTABLE',
      reasoningProfiles: [{ value: 'high', topology: 'ORDINARY' }],
    }]));
    registryWithoutMax.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high']));
    const selectorWithoutMax = new ModelSelector(registryWithoutMax, config);

    const fallthrough = await selectorWithoutMax.resolveSelection(undefined, 'WORKER');
    expect(fallthrough.targetId).toBe('agy_gemini_flash_37_high');

    // Case 2: another model (gpt-5.6-sol) with max reasoning is NOT codex_luna_max -> falls through to AGY
    const registryWithSol = new AdapterRegistry();
    registryWithSol.register(new FakeAdapter('codex', [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      variants: ['max'],
      selectability: 'SELECTABLE',
      reasoningProfiles: [{ value: 'max', topology: 'ORDINARY' }],
    }]));
    registryWithSol.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high']));
    const selectorWithSol = new ModelSelector(registryWithSol, config);

    const fallthroughSol = await selectorWithSol.resolveSelection(undefined, 'WORKER');
    expect(fallthroughSol.targetId).toBe('agy_gemini_flash_37_high');

    // Case 3: gpt-5.6-luna with max reasoning -> successfully resolves codex_luna_max
    const registryWithLunaMax = new AdapterRegistry();
    registryWithLunaMax.register(new FakeAdapter('codex', [{
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      variants: ['high', 'max'],
      selectability: 'SELECTABLE',
      reasoningProfiles: [{ value: 'high', topology: 'ORDINARY' }, { value: 'max', topology: 'ORDINARY' }],
    }]));
    const selectorWithLunaMax = new ModelSelector(registryWithLunaMax, config);

    const lunaMaxSelection = await selectorWithLunaMax.resolveSelection(undefined, 'WORKER');
    expect(lunaMaxSelection.targetId).toBe('codex_luna_max');
    expect(lunaMaxSelection.modelId).toBe('gpt-5.6-luna');
    expect(lunaMaxSelection.variant).toBe('max');
  });

  it('preserves deterministic locked candidate order regardless of targets object key order in policy', async () => {
    const shuffledTargets = {
      opencode_nemotron_3_ultra: target('opencode_nemotron_3_ultra', 'opencode', 'nemotron-3'),
      agy_gemini_flash_37_high: target('agy_gemini_flash_37_high', 'antigravity', 'gemini-3.7-flash-high'),
      cursor_grok_46_xhigh: target('cursor_grok_46_xhigh', 'cursor-cli', 'cursor-grok-4.6-xhigh'),
      opencode_nemotron_35_lightning: target('opencode_nemotron_35_lightning', 'opencode', 'nemotron-3.5'),
    };

    const config = makeConfig(shuffledTargets, {
      INVESTIGATOR: [
        'cursor_grok_46_xhigh',
        'opencode_nemotron_35_lightning',
        'agy_gemini_flash_37_high',
        'opencode_nemotron_3_ultra',
      ],
    });

    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('cursor-cli', ['cursor-grok-4.6-xhigh']));
    registry.register(new FakeAdapter('opencode', ['nemotron-3.5', 'nemotron-3']));
    registry.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high']));
    const selector = new ModelSelector(registry, config);

    // Primary selection must be cursor_grok_46_xhigh
    const first = await selector.resolveSelection(undefined, 'INVESTIGATOR');
    expect(first.targetId).toBe('cursor_grok_46_xhigh');

    // First fallback must be opencode_nemotron_35_lightning
    const fallback1 = await selector.getNextFallback(first, 'INVESTIGATOR', {
      failedTargetIds: new Set(['cursor_grok_46_xhigh']),
    });
    expect(fallback1.targetId).toBe('opencode_nemotron_35_lightning');

    // Second fallback must be agy_gemini_flash_37_high
    const fallback2 = await selector.getNextFallback(fallback1, 'INVESTIGATOR', {
      failedTargetIds: new Set(['cursor_grok_46_xhigh', 'opencode_nemotron_35_lightning']),
    });
    expect(fallback2.targetId).toBe('agy_gemini_flash_37_high');
  });

  it('skips future policy references without inventing a target', async () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
    };
    const config = makeConfig(targets, { INVESTIGATOR: ['unknown_target', 'target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection(undefined, 'INVESTIGATOR');
    expect(selection.targetId).toBe('target_a');
    expect(selection.modelId).toBe('a-model');
  });

  it('requires explicit target/platform binding to agree', async () => {
    const config = makeConfig({ target_a: target('target_a', 'fake-a', 'a-model') }, { WORKER: ['target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection({ targetId: 'target_a', platform: 'fake-b' }, 'WORKER')).rejects.toThrow(
      'MODEL_SELECTION_ERROR'
    );
  });

  it('keeps automatic selection on the requested platform', async () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
      target_b: target('target_b', 'fake-b', 'b-model'),
    };
    const config = makeConfig(targets, { INVESTIGATOR: ['target_a', 'target_b'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection({ platform: 'fake-b', model: 'auto' }, 'INVESTIGATOR');
    expect(selection.targetId).toBe('target_b');
  });

  it('allows same-platform continuation across target IDs only when the adapter proves capability', () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
      target_b: target('target_b', 'fake-a', 'b-model'),
    };
    const config = makeConfig(targets, { WORKER: ['target_a', 'target_b'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model', 'b-model'], { state: 'UNKNOWN' }, true));
    const selector = new ModelSelector(registry, config);
    const next: ResolvedWorkerSelection = {
      targetId: 'target_b',
      platform: 'fake-a',
      modelId: 'b-model',
      reasoningStrategy: 'highest-supported',
    };

    expect(selector.canContinueSession({ targetId: 'target_a', platform: 'fake-a', model: 'a-model' }, next)).toBe(true);
  });

  it('lets an explicit target override reviewer diversification', async () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
      target_b: target('target_b', 'fake-b', 'b-model'),
    };
    const config = makeConfig(targets, { REVIEWER: ['target_b', 'target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config);

    const diversified = await selector.resolveSelection(undefined, 'REVIEWER', new Set(), 'target_b');
    expect(diversified.targetId).toBe('target_a');

    const explicit = await selector.resolveSelection({ targetId: 'target_b' }, 'REVIEWER', new Set(), 'target_b');
    expect(explicit.targetId).toBe('target_b');
  });

  it('resolves the configured explicit-only Opus target only when requested', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high', 'claude-opus-4-6-thinking']));
    registry.register(new FakeAdapter('opencode', ['opencode/deepseek-v4-flash-free']));
    const selector = new ModelSelector(registry, config);

    const automatic = await selector.resolveSelection(undefined, 'INVESTIGATOR');
    expect(automatic.modelId).not.toContain('opus');

    const explicit = await selector.resolveSelection({ model: 'Claude Opus' }, 'INVESTIGATOR');
    expect(explicit.targetId).toBe('agy_claude_opus_46_thinking');
    expect(explicit.isExplicitOnly).toBe(true);
  });

  it('resolves an explicitly discovered target from the requested model', async () => {
    const config = makeConfig({
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        aliases: ['codex'],
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { INVESTIGATOR: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);

    const byTarget = await selector.resolveSelection({
      targetId: 'codex_explicit',
      platform: 'codex',
      model: 'gpt-5',
    }, 'INVESTIGATOR');
    const byPlatform = await selector.resolveSelection({ platform: 'codex', model: 'gpt-5' }, 'INVESTIGATOR');

    expect(byTarget).toMatchObject({ targetId: 'codex_explicit', platform: 'codex', modelId: 'gpt-5' });
    expect(byPlatform).toMatchObject({ targetId: 'codex_explicit', platform: 'codex', modelId: 'gpt-5' });
  });

  it('prefers a same-platform fixed model before a dynamic target', async () => {
    const config = makeConfig({
      dynamic_target: {
        targetId: 'dynamic_target',
        platformId: 'fake-a',
        displayName: 'Dynamic Target',
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
      fixed_target: target('fixed_target', 'fake-a', 'fixed-model'),
    }, { INVESTIGATOR: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['fixed-model', 'dynamic-model']));
    const selector = new ModelSelector(registry, config);

    const fixed = await selector.resolveSelection({ platform: 'fake-a', model: 'fixed-model' }, 'INVESTIGATOR');
    const dynamic = await selector.resolveSelection({ platform: 'fake-a', model: 'dynamic-model' }, 'INVESTIGATOR');

    expect(fixed).toMatchObject({ targetId: 'fixed_target', modelId: 'fixed-model' });
    expect(dynamic).toMatchObject({ targetId: 'dynamic_target', modelId: 'dynamic-model' });
  });

  it('normalizes a legacy mistaken Gemini Flash reference to the configured 3.7 target', async () => {
    const config = validateConfig({
      mailboxRepoPath: 'C:\\test\\mailbox',
      workerRootDir: 'C:\\test\\workers',
      pushWorkerBranches: false,
      notificationsEnabled: false,
      allowedProjects: {},
    });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('antigravity', ['gemini-3.7-flash-high']));
    const selector = new ModelSelector(registry, config);
    const mistakenModel = ['gemini', ['3', '5'].join('.'), 'flash', 'high'].join('-');
    const selection = await selector.resolveSelection({ model: mistakenModel }, 'INVESTIGATOR');
    expect(selection.targetId).toBe('agy_gemini_flash_37_high');
    expect(selection.modelId).toBe('gemini-3.7-flash-high');
  });

  it('skips a target recorded in cooldown and retries it after the authoritative time', async () => {
    const ledgerPath = path.join(os.tmpdir(), `target-availability-${Date.now()}-${Math.random()}.json`);
    const availability = new TargetAvailabilityLedger(ledgerPath);
    const targets = {
      target_b: target('target_b', 'fake-b', 'b-model'),
      target_a: target('target_a', 'fake-a', 'a-model'),
    };
    const config = makeConfig(targets, { INVESTIGATOR: ['target_b', 'target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config, availability);
    const now = new Date('2026-08-14T20:00:00.000Z');
    const retryAt = new Date('2026-08-14T21:00:00.000Z');

    availability.recordFailure(targets.target_b, 'QUOTA_EXHAUSTED', now.toISOString(), retryAt.toISOString(), 'retry-after: 3600');
    expect((await selector.resolveSelection(undefined, 'INVESTIGATOR', new Set(), undefined, now)).targetId).toBe('target_a');
    expect((await selector.resolveSelection(undefined, 'INVESTIGATOR', new Set(), undefined, retryAt)).targetId).toBe('target_b');

    if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  });

  it('never automatically selects or probes an explicit-only Codex target', async () => {
    const targets = {
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        reasoning: { strategy: 'highest-supported' as const },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED' as const,
      },
      target_a: target('target_a', 'fake-a', 'a-model'),
    };
    const config = makeConfig(targets, { INVESTIGATOR: ['codex_explicit', 'target_a'] });
    const codex = new FakeAdapter('codex', ['gpt-5']);
    const registry = new AdapterRegistry();
    registry.register(codex);
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection(undefined, 'INVESTIGATOR');

    expect(selection.targetId).toBe('target_a');
    expect(codex.quotaProbeCount).toBe(0);
  });

  it('does not infer a Codex model from an automatic platform-only request', async () => {
    const targets = {
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        reasoning: { strategy: 'highest-supported' as const },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED' as const,
      },
    };
    const config = makeConfig(targets, { INVESTIGATOR: ['codex_explicit'] });
    const codex = new FakeAdapter('codex', ['gpt-5']);
    const registry = new AdapterRegistry();
    registry.register(codex);
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection({ platform: 'codex', model: 'auto' }, 'INVESTIGATOR')).rejects.toThrow(
      'No eligible INVESTIGATOR worker targets are available'
    );
    expect(codex.quotaProbeCount).toBe(0);
  });

  it('does not infer Codex from a raw model ID without an explicit platform or target', async () => {
    const config = makeConfig({
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        aliases: ['codex'],
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { INVESTIGATOR: [] });
    const codex = new FakeAdapter('codex', ['gpt-5']);
    const registry = new AdapterRegistry();
    registry.register(codex);
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection({ model: 'gpt-5' }, 'INVESTIGATOR')).rejects.toThrow(
      'is not configured in local target policy'
    );
    expect(codex.quotaProbeCount).toBe(0);
  });

  it('rejects ambiguous explicit-discovered targets on one platform', async () => {
    const config = makeConfig({
      codex_one: {
        targetId: 'codex_one', platformId: 'codex', displayName: 'Codex one',
        aliases: ['codex_one'], reasoning: { strategy: 'highest-supported' },
        explicitOnly: true, modelBinding: 'EXPLICIT_DISCOVERED',
      },
      codex_two: {
        targetId: 'codex_two', platformId: 'codex', displayName: 'Codex two',
        aliases: ['codex_two'], reasoning: { strategy: 'highest-supported' },
        explicitOnly: true, modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { INVESTIGATOR: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection({ platform: 'codex', model: 'gpt-5' }, 'INVESTIGATOR')).rejects.toThrow(
      'ambiguous explicitly discovered targets'
    );
  });

  it('returns the exact catalog model identity for an explicit platform request', async () => {
    const config = makeConfig({
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        aliases: ['codex'],
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { INVESTIGATOR: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('codex', [{
      id: 'gpt-5.6-dynamic',
      displayName: 'GPT-5.6 Dynamic',
      variants: ['max'],
      selectability: 'SELECTABLE',
    }]));
    const selector = new ModelSelector(registry, config);

    await expect(selector.resolveSelection({ platform: 'codex', model: 'GPT-5.6-DYNAMIC' }, 'INVESTIGATOR')).resolves.toMatchObject({
      targetId: 'codex_explicit',
      modelId: 'gpt-5.6-dynamic',
      isExplicitOnly: true,
    });
  });

  it('rejects a discovered model that is not selectable with a typed failure', async () => {
    const config = makeConfig({
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { INVESTIGATOR: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('codex', [{
      id: 'hidden-model',
      displayName: 'Hidden model',
      variants: [],
      selectability: 'NOT_SELECTABLE',
    }]));
    const selector = new ModelSelector(registry, config);

    const error = await selector.resolveSelection({ platform: 'codex', model: 'hidden-model' }, 'INVESTIGATOR').catch((value) => value);
    expect(error.failureClass).toBe('MODEL_NOT_SELECTABLE');
  });

  it('allows an explicit Codex reviewer override after a same-producer selection', async () => {
    const config = makeConfig({
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        aliases: ['codex'],
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
      producer: target('producer', 'fake-a', 'producer-model'),
    }, { REVIEWER: ['producer'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['producer-model']));
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection({ platform: 'codex', model: 'gpt-5' }, 'REVIEWER', new Set(), 'producer');

    expect(selection.targetId).toBe('codex_explicit');
  });

  it('uses an authorized explicit fallback without consulting role rankings', async () => {
    const config = makeConfig({
      current: target('current', 'fake-a', 'a-model'),
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        aliases: ['codex'],
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { WORKER: ['current'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);
    const current: ResolvedWorkerSelection = {
      targetId: 'current', platform: 'fake-a', modelId: 'a-model', reasoningStrategy: 'highest-supported',
    };

    const selection = await selector.getNextFallback(current, 'WORKER', {
      failedTargetIds: new Set(['current']),
      authorizedFallback: { platform: 'codex', model: 'gpt-5' },
    });

    expect(selection.targetId).toBe('codex_explicit');
  });

  it('does not select Codex as an automatic fallback without authorization', async () => {
    const config = makeConfig({
      current: target('current', 'fake-a', 'a-model'),
      codex_explicit: {
        targetId: 'codex_explicit',
        platformId: 'codex',
        displayName: 'Codex',
        reasoning: { strategy: 'highest-supported' },
        explicitOnly: true,
        modelBinding: 'EXPLICIT_DISCOVERED',
      },
    }, { WORKER: ['current', 'codex_explicit'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);
    const current: ResolvedWorkerSelection = {
      targetId: 'current', platform: 'fake-a', modelId: 'a-model', reasoningStrategy: 'highest-supported',
    };

    await expect(selector.getNextFallback(current, 'WORKER', { failedTargetIds: new Set(['current']) })).rejects.toThrow(
      'No eligible WORKER worker targets are available'
    );
  });
});
