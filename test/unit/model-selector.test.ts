import { describe, it, expect } from 'vitest';
import { ModelSelector, ResolvedWorkerSelection } from '../../src/engine/model-selector.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { WorkerAdapter, WorkerPlatformInfo } from '../../src/worker/worker-adapter.js';
import { validateConfig } from '../../src/config.js';
import {
  DiscoveredModel,
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

  constructor(
    platformId: string,
    models: string[],
    quotaState: QuotaProbeResult = { state: 'UNKNOWN' },
    supportsCrossModelSessionContinuation = false
  ) {
    this.platformId = platformId;
    this.supportsCrossModelSessionContinuation = supportsCrossModelSessionContinuation;
    this.models = models.map((id) => ({
      id,
      displayName: id,
      variants: ['high'],
      highestVariant: 'high',
    }));
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

  async resolveReasoningProfile(): Promise<string | undefined> {
    return 'high';
  }

  async probeQuota(): Promise<QuotaProbeResult> {
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

function target(targetId: string, platformId: string, modelId: string): WorkerTargetConfig {
  return {
    targetId,
    platformId,
    modelId,
    displayName: targetId,
    aliases: [targetId],
    reasoning: { strategy: 'highest-supported' },
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
      PLANNER: ['target_b', 'target_a'],
      INVESTIGATOR: ['target_c'],
      WORKER: ['target_a'],
      REVIEWER: ['target_b', 'target_a'],
    });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model', 'c-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config);

    expect((await selector.resolveSelection(undefined, 'PLANNER')).targetId).toBe('target_b');
    expect((await selector.resolveSelection(undefined, 'INVESTIGATOR')).targetId).toBe('target_c');
    expect((await selector.resolveSelection(undefined, 'WORKER')).targetId).toBe('target_a');
    expect((await selector.resolveSelection(undefined, 'REVIEWER')).targetId).toBe('target_b');
  });

  it('skips future policy references without inventing a target', async () => {
    const targets = {
      target_a: target('target_a', 'fake-a', 'a-model'),
    };
    const config = makeConfig(targets, { PLANNER: ['cursor_grok_46_xhigh', 'target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection(undefined, 'PLANNER');
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
    const config = makeConfig(targets, { PLANNER: ['target_a', 'target_b'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config);

    const selection = await selector.resolveSelection({ platform: 'fake-b', model: 'auto' }, 'PLANNER');
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

    const automatic = await selector.resolveSelection(undefined, 'PLANNER');
    expect(automatic.modelId).not.toContain('opus');

    const explicit = await selector.resolveSelection({ model: 'Claude Opus' }, 'PLANNER');
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
    }, { PLANNER: [] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('codex', ['gpt-5']));
    const selector = new ModelSelector(registry, config);

    const byTarget = await selector.resolveSelection({
      targetId: 'codex_explicit',
      platform: 'codex',
      model: 'gpt-5',
    }, 'PLANNER');
    const byPlatform = await selector.resolveSelection({ platform: 'codex', model: 'gpt-5' }, 'PLANNER');

    expect(byTarget).toMatchObject({ targetId: 'codex_explicit', platform: 'codex', modelId: 'gpt-5' });
    expect(byPlatform).toMatchObject({ targetId: 'codex_explicit', platform: 'codex', modelId: 'gpt-5' });
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
    const selection = await selector.resolveSelection({ model: mistakenModel }, 'PLANNER');
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
    const config = makeConfig(targets, { PLANNER: ['target_b', 'target_a'] });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter('fake-a', ['a-model']));
    registry.register(new FakeAdapter('fake-b', ['b-model']));
    const selector = new ModelSelector(registry, config, availability);
    const now = new Date('2026-08-14T20:00:00.000Z');
    const retryAt = new Date('2026-08-14T21:00:00.000Z');

    availability.recordFailure(targets.target_b, 'QUOTA_EXHAUSTED', now.toISOString(), retryAt.toISOString(), 'retry-after: 3600');
    expect((await selector.resolveSelection(undefined, 'PLANNER', new Set(), undefined, now)).targetId).toBe('target_a');
    expect((await selector.resolveSelection(undefined, 'PLANNER', new Set(), undefined, retryAt)).targetId).toBe('target_b');

    if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  });
});
