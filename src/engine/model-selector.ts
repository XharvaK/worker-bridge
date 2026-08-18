import * as path from 'node:path';
import { getDefaultSelectionPolicy, normalizeLegacyGeminiReference } from '../config.js';
import {
  BridgeConfig,
  DiscoveredModel,
  ExecutionMode,
  JobIntent,
  ReasoningStrategy,
  SelectionPolicyConfig,
  ExplicitFallbackSelection,
  WorkerSessionIdentity,
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
import { WorkerAdapterError } from '../worker/worker-adapter.js';

export interface FallbackResolutionOptions {
  failedTargetIds: Set<string>;
  avoidTargetId?: string;
  now?: Date;
  authorizedFallback?: ExplicitFallbackSelection;
  excludedPlatforms?: Set<string> | string[];
}

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

  private resolveRole(roleOrIntent: WorkerRole | JobIntent | string): WorkerRole {
    if (roleOrIntent === 'INVESTIGATOR' || roleOrIntent === 'WORKER' || roleOrIntent === 'REVIEWER') {
      return roleOrIntent as WorkerRole;
    }
    if (roleOrIntent === 'PLANNER') {
      throw new Error('INVALID_ROLE: Role "PLANNER" is not a selectable Worker Bridge role. Expected INVESTIGATOR, WORKER, or REVIEWER.');
    }
    return roleForJob(roleOrIntent as JobIntent);
  }

  private findTarget(requested: WorkerSelection): WorkerTargetConfig | null {
    const targets = Object.values(this.policy.targets || {});
    if (requested.targetId) {
      return this.policy.targets[requested.targetId] || null;
    }

    const rawModel = normalizeLegacyGeminiReference(requested.model?.trim() || '');
    if (!rawModel) {
      if (requested.platform) {
        const platformTargets = targets.filter(
          (t) => t.platformId.toLowerCase() === requested.platform!.toLowerCase()
        );
        if (platformTargets.length === 1) return platformTargets[0];
      }
      return null;
    }
    const normalized = this.normalizeAliasString(rawModel);
    const matchesRequestedModel = (target: WorkerTargetConfig): boolean => {
      const aliases = [target.targetId, target.displayName, target.modelId, ...(target.aliases || [])].filter(
        (alias): alias is string => typeof alias === 'string'
      );
      return aliases.some((alias) => this.normalizeAliasString(alias) === normalized);
    };
    const matchesPlatform = (target: WorkerTargetConfig): boolean =>
      !requested.platform || target.platformId.toLowerCase() === requested.platform.toLowerCase();

    const explicitDiscoveredForPlatform = requested.platform
      ? targets.filter(
          (target) => target.platformId.toLowerCase() === requested.platform!.toLowerCase() &&
            target.modelBinding === 'EXPLICIT_DISCOVERED'
        )
      : [];
    if (explicitDiscoveredForPlatform.length > 1) {
      const matchingDynamic = explicitDiscoveredForPlatform.filter(matchesRequestedModel);
      if (matchingDynamic.length !== 1) {
        throw new Error(
          `MODEL_SELECTION_ERROR: Platform "${requested.platform}" has ambiguous explicitly discovered targets.`
        );
      }
      return matchingDynamic[0];
    }

    const fixedMatch = targets.find(
      (target) => matchesPlatform(target) && target.modelBinding !== 'EXPLICIT_DISCOVERED' && matchesRequestedModel(target)
    );
    if (fixedMatch) return fixedMatch;

    return targets.find(
      (target) => matchesPlatform(target) &&
        (matchesRequestedModel(target) || !!requested.platform && target.modelBinding === 'EXPLICIT_DISCOVERED')
    ) || null;
  }

  private async discoverFor(adapter: ReturnType<AdapterRegistry['get']>, explicit = false): Promise<DiscoveredModel[]> {
    if (!adapter) return [];
    try {
      return await adapter.discoverModels();
    } catch (error) {
      if (explicit && error instanceof WorkerAdapterError) throw error;
      if (explicit) throw new WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', `Model discovery failed: ${String(error)}`);
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

    if (target.modelBinding === 'PROVIDER_MANAGED') {
      const quota = await adapter.probeQuota(target.modelId);
      if (quota.state === 'EXHAUSTED' || quota.state === 'ERROR') {
        const failureClass = quota.failureClass || (quota.state === 'EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'AUTOMATION_SEAM_UNAVAILABLE');
        throw new WorkerAdapterError(failureClass, quota.details || 'Provider headless automation seam is unavailable.');
      }
      return {
        targetId: target.targetId,
        platform: target.platformId,
        modelId: target.modelId || 'provider-managed',
        variant: undefined,
        reasoningStrategy: 'provider-managed',
        isExplicitOnly: target.explicitOnly,
        resolvedFromAlias: target.displayName,
      };
    }

    const discovered = await this.discoverFor(adapter, explicit);
    const modelId = target.modelBinding === 'EXPLICIT_DISCOVERED' ? requested?.model?.trim() : target.modelId;
    if (!modelId) {
      throw new WorkerAdapterError('MODEL_NOT_FOUND', `Target "${target.targetId}" requires an explicitly discovered model.`);
    }
    const discoveredModel = discovered.find((model) => model.id.toLowerCase() === modelId.toLowerCase());
    if (!discoveredModel) {
      throw new WorkerAdapterError('MODEL_NOT_FOUND', `Exact model "${modelId}" is not discovered on platform "${target.platformId}".`);
    }
    if (explicit && target.modelBinding === 'EXPLICIT_DISCOVERED' && discoveredModel.selectability !== 'SELECTABLE') {
      throw new WorkerAdapterError('MODEL_NOT_SELECTABLE', `Exact model "${discoveredModel.id}" is not selectable on platform "${target.platformId}".`);
    }

    const requestedReasoning = requested?.reasoning;
    const policyReasoning = target.reasoning || { strategy: 'highest-supported' as const };
    const strategy = requestedReasoning?.strategy || policyReasoning.strategy;
    const explicitValue = requestedReasoning?.value || policyReasoning.value;
    const effectiveModelId = target.modelBinding === 'EXPLICIT_DISCOVERED' ? discoveredModel.id : modelId;
    const variant = await adapter.resolveReasoningProfile(
      effectiveModelId,
      strategy,
      explicitValue
    );

    if (!explicit && !this.availability.isEligible(target.targetId, now)) {
      throw new Error(`MODEL_SELECTION_ERROR: Target "${target.targetId}" is unavailable.`);
    }

    return {
      targetId: target.targetId,
      platform: target.platformId,
      modelId: effectiveModelId,
      variant,
      reasoningStrategy: strategy,
      isExplicitOnly: target.explicitOnly,
      resolvedFromAlias: target.displayName,
    };
  }

  async resolveExplicitSelection(
    requested: WorkerSelection,
    excludedPlatforms?: Set<string> | string[]
  ): Promise<ResolvedWorkerSelection> {
    const excludedPlats = excludedPlatforms instanceof Set
      ? excludedPlatforms
      : new Set(excludedPlatforms ? (Array.isArray(excludedPlatforms) ? excludedPlatforms : [excludedPlatforms]) : []);

    if (requested.platform && (requested.platform.toLowerCase() === 'cursor-agent' || excludedPlats.has(requested.platform.toLowerCase()))) {
      throw new WorkerAdapterError(
        'RECURSION_BLOCKED',
        `Platform "${requested.platform}" is excluded in this execution context (recursion blocked).`
      );
    }

    const target = this.findTarget(requested);
    if (!target) {
      throw new Error(
        `MODEL_SELECTION_ERROR: Explicit target "${requested.targetId || requested.model || ''}" is not configured in local target policy.`
      );
    }

    if (target.platformId.toLowerCase() === 'cursor-agent' || excludedPlats.has(target.platformId.toLowerCase())) {
      throw new WorkerAdapterError(
        'RECURSION_BLOCKED',
        `Platform "${target.platformId}" for target "${target.targetId}" is excluded in this execution context (recursion blocked).`
      );
    }

    return this.resolveTarget(target, requested, true);
  }

  async resolveSelection(
    requested?: WorkerSelection,
    roleOrIntent: WorkerRole | JobIntent = 'INVESTIGATOR',
    excludedTargetIds: Set<string> | ExecutionMode = new Set(),
    avoidTargetId?: string,
    now = new Date(),
    excludedPlatforms?: Set<string> | string[]
  ): Promise<ResolvedWorkerSelection> {
    const excludedPlats = excludedPlatforms instanceof Set
      ? excludedPlatforms
      : new Set(excludedPlatforms ? (Array.isArray(excludedPlatforms) ? excludedPlatforms : [excludedPlatforms]) : []);

    const explicit = !!requested && (!!requested.targetId || (!!requested.model && !['auto', 'your call'].includes(requested.model.toLowerCase())));
    if (explicit) {
      return this.resolveExplicitSelection(requested!, excludedPlats);
    }

    const role = this.resolveRole(roleOrIntent);
    const excluded = excludedTargetIds instanceof Set ? excludedTargetIds : new Set<string>();
    const ranking = this.policy.roleRankings?.[role] || [];
    const requestedPlatform = requested?.platform?.toLowerCase();
    const candidates = ranking.filter((targetId) => {
      if (excluded.has(targetId)) return false;
      const target = this.policy.targets[targetId];
      if (target && excludedPlats.has(target.platformId.toLowerCase())) return false;
      if (!requestedPlatform) return true;
      return target?.platformId.toLowerCase() === requestedPlatform;
    });
    const ordered = avoidTargetId
      ? [...candidates.filter((targetId) => targetId !== avoidTargetId), ...candidates.filter((targetId) => targetId === avoidTargetId)]
      : candidates;

    for (const targetId of ordered) {
      const target = this.policy.targets[targetId];
      if (!target || target.explicitOnly) continue;
      if (excludedPlats.has(target.platformId.toLowerCase())) continue;
      if (!this.platformEnabled(target.platformId) || !this.availability.isEligible(targetId, now)) continue;

      const adapter = this.registry.get(target.platformId);
      if (!adapter) continue;

      const env = await adapter.inspectEnvironment();
      if (!env.installed) continue;

      const quota = await adapter.probeQuota(target.modelId);
      if (quota.state === 'EXHAUSTED' || quota.state === 'ERROR') {
        this.availability.recordFailure(
          target,
          quota.failureClass || (quota.state === 'EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'PROCESS_FAILED'),
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
    options: FallbackResolutionOptions
  ): Promise<ResolvedWorkerSelection>;
  async getNextFallback(
    current: ResolvedWorkerSelection,
    roleOrIntent: WorkerRole | JobIntent,
    excludedOrMode: ExecutionMode | Set<string>,
    failedTargetIds?: Set<string>,
    avoidTargetId?: string,
    now?: Date
  ): Promise<ResolvedWorkerSelection>;
  async getNextFallback(
    current: ResolvedWorkerSelection,
    roleOrIntent: WorkerRole | JobIntent,
    optionsOrMode: FallbackResolutionOptions | ExecutionMode | Set<string>,
    failedTargetIds?: Set<string>,
    avoidTargetId?: string,
    legacyNow = new Date()
  ): Promise<ResolvedWorkerSelection> {
    const options: FallbackResolutionOptions = optionsOrMode instanceof Set
      ? { failedTargetIds: optionsOrMode, avoidTargetId, now: legacyNow }
      : typeof optionsOrMode === 'object'
        ? optionsOrMode
        : { failedTargetIds: failedTargetIds || new Set<string>(), avoidTargetId, now: legacyNow };
    if (options.authorizedFallback) {
      const explicit = await this.resolveExplicitSelection(options.authorizedFallback, options.excludedPlatforms);
      if (options.failedTargetIds.has(explicit.targetId) || explicit.targetId === current.targetId) {
        throw new Error(`MODEL_SELECTION_ERROR: Authorized fallback target "${explicit.targetId}" has already failed.`);
      }
      return explicit;
    }
    const excluded = new Set(options.failedTargetIds);
    excluded.add(current.targetId);
    return this.resolveSelection(
      undefined,
      roleOrIntent,
      excluded,
      options.avoidTargetId,
      options.now || new Date(),
      options.excludedPlatforms
    );
  }

  canContinueSession(
    previous: WorkerSessionIdentity,
    next: ResolvedWorkerSelection,
    requestedMode: ExecutionMode,
    currentWorktreeCwd?: string
  ): boolean;
  canContinueSession(
    previous: { targetId?: string; platform?: string; model?: string },
    next: ResolvedWorkerSelection
  ): boolean;
  canContinueSession(
    previous: WorkerSessionIdentity | { targetId?: string; platform?: string; model?: string },
    next: ResolvedWorkerSelection,
    requestedMode?: ExecutionMode,
    currentWorktreeCwd?: string
  ): boolean {
    // Preserve the pre-session-identity compatibility call used by older adapters.
    if (requestedMode === undefined) {
      if (previous.targetId === next.targetId) return true;
      if (!previous.platform || previous.platform !== next.platform) return false;
      if (previous.model === next.modelId) return true;
      return this.registry.get(next.platform)?.supportsCrossModelSessionContinuation === true;
    }

    const identity = previous as WorkerSessionIdentity;
    if (
      !identity.targetId ||
      !identity.sessionId ||
      !identity.platform ||
      !identity.model ||
      !identity.reasoning ||
      !identity.worktreeCwd ||
      !next.targetId ||
      !next.variant ||
      !currentWorktreeCwd
    ) return false;
    if (identity.platform !== next.platform || identity.executionMode !== requestedMode) return false;
    if (currentWorktreeCwd !== undefined) {
      const previousPath = path.resolve(identity.worktreeCwd);
      const currentPath = path.resolve(currentWorktreeCwd);
      const pathsMatch = process.platform === 'win32'
        ? previousPath.toLowerCase() === currentPath.toLowerCase()
        : previousPath === currentPath;
      if (!pathsMatch) return false;
    }
    if (identity.reasoning !== next.variant) return false;
    if (identity.targetId === next.targetId && identity.model === next.modelId) return true;
    if (identity.model === next.modelId) return false;
    return this.registry.get(next.platform)?.supportsCrossModelSessionContinuation === true;
  }
}
