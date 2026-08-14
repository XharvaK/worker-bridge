import { getDefaultSelectionPolicy, normalizeLegacyGeminiReference } from '../config.js';
import {
  BridgeConfig,
  DiscoveredModel,
  ExecutionMode,
  JobIntent,
  ReasoningStrategy,
  SelectionPolicyConfig,
  WorkerRole,
  WorkerSelection,
  WorkerTargetConfig,
} from '../types.js';
import { roleForJob } from './job-role.js';
import {
  InMemoryTargetAvailabilityStore,
  TargetAvailabilityStore,
} from './target-availability-ledger.js';
import { AdapterRegistry } from '../worker/adapter-registry.js';

export interface ResolvedWorkerSelection {
  targetId: string;
  platform: string;
  modelId: string;
  variant?: string;
  reasoningStrategy: ReasoningStrategy;
  isExplicitOnly?: boolean;
  resolvedFromAlias?: string;
}

export class ModelSelector {
  private readonly registry: AdapterRegistry;
  private readonly config?: BridgeConfig;
  private readonly policy: SelectionPolicyConfig;
  private readonly availability: TargetAvailabilityStore;

  constructor(
    registry: AdapterRegistry,
    config?: BridgeConfig,
    availability: TargetAvailabilityStore = new InMemoryTargetAvailabilityStore()
  ) {
    this.registry = registry;
    this.config = config;
    this.policy = config?.selectionPolicy || getDefaultSelectionPolicy();
    this.availability = availability;
  }

  normalizeAliasString(input: string): string {
    return input.trim().toLowerCase().replace(/[\s\-_.]+/g, '_');
  }

  getPolicy(): SelectionPolicyConfig {
    return this.policy;
  }

  getTargetConfig(targetId: string): WorkerTargetConfig | undefined {
    return this.policy.targets[targetId];
  }

  isTargetEligible(targetId: string, now = new Date()): boolean {
    return this.availability.isEligible(targetId, now);
  }

  private resolveRole(roleOrIntent: WorkerRole | JobIntent): WorkerRole {
    if (['PLANNER', 'INVESTIGATOR', 'WORKER', 'REVIEWER'].includes(roleOrIntent)) {
      return roleOrIntent as WorkerRole;
    }
    return roleForJob(roleOrIntent as JobIntent);
  }

  private findTarget(requested: WorkerSelection): WorkerTargetConfig | null {
    const targets = Object.values(this.policy.targets || {});
    if (requested.targetId) {
      return this.policy.targets[requested.targetId] || null;
    }

    const rawModel = normalizeLegacyGeminiReference(requested.model?.trim() || '');
    if (!rawModel) return null;
    const normalized = this.normalizeAliasString(rawModel);
    return (
      targets.find((target) => {
        if (requested.platform && target.platformId.toLowerCase() !== requested.platform.toLowerCase()) return false;
        if (requested.platform && target.modelBinding === 'EXPLICIT_DISCOVERED') return true;
        const aliases = [target.targetId, target.displayName, target.modelId, ...(target.aliases || [])].filter(
          (alias): alias is string => typeof alias === 'string'
        );
        return aliases.some((alias) => this.normalizeAliasString(alias) === normalized);
      }) || null
    );
  }

  private async discoverFor(adapter: ReturnType<AdapterRegistry['get']>): Promise<DiscoveredModel[]> {
    if (!adapter) return [];
    try {
      return await adapter.discoverModels();
    } catch {
      return [];
    }
  }

  private platformEnabled(platformId: string): boolean {
    return this.config?.platforms?.[platformId]?.enabled !== false;
  }

  private async resolveTarget(
    target: WorkerTargetConfig,
    requested?: WorkerSelection,
    explicit = false,
    now = new Date()
  ): Promise<ResolvedWorkerSelection> {
    if (requested?.platform && requested.platform.toLowerCase() !== target.platformId.toLowerCase()) {
      throw new Error(
        `MODEL_SELECTION_ERROR: Requested platform "${requested.platform}" does not match target "${target.targetId}" bound to "${target.platformId}".`
      );
    }
    if (!this.platformEnabled(target.platformId)) {
      throw new Error(`MODEL_SELECTION_ERROR: Platform "${target.platformId}" is disabled by local policy.`);
    }

    const adapter = this.registry.get(target.platformId);
    if (!adapter) {
      throw new Error(`MODEL_SELECTION_ERROR: Platform "${target.platformId}" is not registered or supported.`);
    }

    const env = await adapter.inspectEnvironment();
    if (!env.installed) {
      throw new Error(env.error || `MODEL_SELECTION_ERROR: Platform "${target.platformId}" is not installed.`);
    }

    const discovered = await this.discoverFor(adapter);
    const modelId = target.modelBinding === 'EXPLICIT_DISCOVERED' ? requested?.model?.trim() : target.modelId;
    if (!modelId) {
      throw new Error(`MODEL_SELECTION_ERROR: Target "${target.targetId}" requires an explicitly discovered model.`);
    }
    const discoveredModel = discovered.find((model) => model.id.toLowerCase() === modelId.toLowerCase());
    if (!discoveredModel) {
      throw new Error(
        `MODEL_SELECTION_ERROR: Exact model "${modelId}" is not discovered on platform "${target.platformId}".`
      );
    }

    const requestedReasoning = requested?.reasoning;
    const policyReasoning = target.reasoning || { strategy: 'highest-supported' as const };
    const strategy = requestedReasoning?.strategy || policyReasoning.strategy;
    const explicitValue = requestedReasoning?.value || policyReasoning.value;
    const variant = await adapter.resolveReasoningProfile(
      modelId,
      strategy,
      explicitValue
    );

    if (!explicit && !this.availability.isEligible(target.targetId, now)) {
      throw new Error(`MODEL_SELECTION_ERROR: Target "${target.targetId}" is unavailable.`);
    }

    return {
      targetId: target.targetId,
      platform: target.platformId,
      modelId,
      variant,
      reasoningStrategy: strategy,
      isExplicitOnly: target.explicitOnly,
      resolvedFromAlias: target.displayName,
    };
  }

  async resolveExplicitSelection(requested: WorkerSelection): Promise<ResolvedWorkerSelection> {
    const target = this.findTarget(requested);
    if (!target) {
      throw new Error(
        `MODEL_SELECTION_ERROR: Explicit target "${requested.targetId || requested.model || ''}" is not configured in local target policy.`
      );
    }
    return this.resolveTarget(target, requested, true);
  }

  async resolveSelection(
    requested?: WorkerSelection,
    roleOrIntent: WorkerRole | JobIntent = 'PLANNER',
    excludedTargetIds: Set<string> | ExecutionMode = new Set(),
    avoidTargetId?: string,
    now = new Date()
  ): Promise<ResolvedWorkerSelection> {
    const explicit = !!requested && (!!requested.targetId || (!!requested.model && !['auto', 'your call'].includes(requested.model.toLowerCase())));
    if (explicit) {
      return this.resolveExplicitSelection(requested!);
    }

    const role = this.resolveRole(roleOrIntent);
    const excluded = excludedTargetIds instanceof Set ? excludedTargetIds : new Set<string>();
    const ranking = this.policy.roleRankings?.[role] || [];
    const requestedPlatform = requested?.platform?.toLowerCase();
    const candidates = ranking.filter((targetId) => {
      if (excluded.has(targetId)) return false;
      if (!requestedPlatform) return true;
      const target = this.policy.targets[targetId];
      return target?.platformId.toLowerCase() === requestedPlatform;
    });
    const ordered = avoidTargetId
      ? [...candidates.filter((targetId) => targetId !== avoidTargetId), ...candidates.filter((targetId) => targetId === avoidTargetId)]
      : candidates;

    for (const targetId of ordered) {
      const target = this.policy.targets[targetId];
      if (!target || target.explicitOnly) continue;
      if (!this.platformEnabled(target.platformId) || !this.availability.isEligible(targetId, now)) continue;

      const adapter = this.registry.get(target.platformId);
      if (!adapter) continue;

      const env = await adapter.inspectEnvironment();
      if (!env.installed) continue;

      const quota = await adapter.probeQuota(target.modelId);
      if (quota.state === 'EXHAUSTED' || quota.state === 'ERROR') {
        this.availability.recordFailure(
          target,
          quota.state === 'EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'PROCESS_FAILED',
          new Date().toISOString(),
          quota.resetsAt,
          quota.details,
          'quota_probe'
        );
        continue;
      }

      try {
        return await this.resolveTarget(target, requested, false, now);
      } catch {
        continue;
      }
    }

    throw new Error(`MODEL_SELECTION_ERROR: No eligible ${role} worker targets are available.`);
  }

  async getNextFallback(
    current: ResolvedWorkerSelection,
    roleOrIntent: WorkerRole | JobIntent,
    excludedOrMode: ExecutionMode | Set<string>,
    failedTargetIds?: Set<string>,
    avoidTargetId?: string,
    now = new Date()
  ): Promise<ResolvedWorkerSelection> {
    const excluded = new Set(
      failedTargetIds || (excludedOrMode instanceof Set ? excludedOrMode : new Set<string>())
    );
    excluded.add(current.targetId);
    return this.resolveSelection(undefined, roleOrIntent, excluded, avoidTargetId, now);
  }

  canContinueSession(
    previous: { targetId?: string; platform?: string; model?: string },
    next: ResolvedWorkerSelection
  ): boolean {
    if (previous.targetId === next.targetId) return true;
    if (!previous.platform || previous.platform !== next.platform) return false;
    if (previous.model === next.modelId) return true;
    return this.registry.get(next.platform)?.supportsCrossModelSessionContinuation === true;
  }
}
