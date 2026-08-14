import {
  DiscoveredModel,
  DiscoveredReasoningProfile,
  ModelSelectability,
  ReasoningTopology,
} from '../types.js';
import { WorkerAdapterError } from './worker-adapter.js';

export interface CodexCatalogParseResult {
  models: DiscoveredModel[];
  source: 'bundled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value) {
    throw new WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', `Invalid Codex catalog: ${fieldName} must be a string.`);
  }
  return value;
}

function normalizeSelectability(model: Record<string, unknown>): ModelSelectability {
  if (model.visibility === 'hide' || model.supported_in_api === false) {
    return 'NOT_SELECTABLE';
  }
  if (model.visibility === 'list' && model.supported_in_api !== false) {
    return 'SELECTABLE';
  }
  return 'UNKNOWN';
}

function normalizeTopologyValue(value: unknown): ReasoningTopology | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase().replace(/[-\s]/g, '_');
  if (['ordinary', 'standard', 'standard_reasoning'].includes(normalized)) return 'ORDINARY';
  if (['topology_changing', 'delegating', 'delegation', 'automatic_delegation'].includes(normalized)) {
    return 'TOPOLOGY_CHANGING';
  }
  if (normalized === 'unknown') return 'UNKNOWN';
  return undefined;
}

function classifyReasoningTopology(profile: Record<string, unknown>): ReasoningTopology {
  const explicit =
    normalizeTopologyValue(profile.topology) ??
    normalizeTopologyValue(profile.reasoning_topology) ??
    normalizeTopologyValue(profile.topology_class);
  if (explicit) return explicit;

  const description = typeof profile.description === 'string' ? profile.description.toLowerCase() : '';
  if (description.includes('automatic delegation') || description.includes('delegated work')) {
    return 'TOPOLOGY_CHANGING';
  }
  if (description.includes('ordinary reasoning') || description.includes('standard reasoning')) {
    return 'ORDINARY';
  }
  return 'UNKNOWN';
}

function parseReasoningProfiles(value: unknown): DiscoveredReasoningProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkerAdapterError(
      'MODEL_DISCOVERY_UNAVAILABLE',
      'Invalid Codex catalog: supported_reasoning_levels must be an array.'
    );
  }

  return value.map((profile, index) => {
    if (!isRecord(profile)) {
      throw new WorkerAdapterError(
        'MODEL_DISCOVERY_UNAVAILABLE',
        `Invalid Codex catalog: supported_reasoning_levels[${index}] must be an object.`
      );
    }
    const description = typeof profile.description === 'string' ? profile.description : undefined;
    return {
      value: requireString(profile.effort, `supported_reasoning_levels[${index}].effort`),
      topology: classifyReasoningTopology(profile),
      description,
    };
  });
}

export function parseCodexModelCatalog(raw: unknown): CodexCatalogParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    throw new WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', 'Invalid Codex catalog: models array is required.');
  }

  return {
    source: 'bundled',
    models: raw.models.map((model, index) => {
      if (!isRecord(model)) {
        throw new WorkerAdapterError('MODEL_DISCOVERY_UNAVAILABLE', `Invalid Codex catalog: models[${index}] must be an object.`);
      }

      return {
        id: requireString(model.slug, `models[${index}].slug`),
        displayName: requireString(model.display_name, `models[${index}].display_name`),
        variants: [],
        reasoningProfiles: parseReasoningProfiles(model.supported_reasoning_levels),
        selectability: normalizeSelectability(model),
      };
    }),
  };
}

export function assertCodexModelSelectable(model: DiscoveredModel): void {
  if (model.selectability !== 'SELECTABLE') {
    throw new WorkerAdapterError('MODEL_NOT_SELECTABLE', `Codex model is not user-selectable: ${model.id}`);
  }
}

export function resolveCodexReasoningProfile(
  model: DiscoveredModel,
  strategy: 'highest-supported' | 'explicit',
  explicitValue?: string
): DiscoveredReasoningProfile {
  const profiles = model.reasoningProfiles ?? [];

  if (strategy === 'explicit') {
    const profile = profiles.find((candidate) => candidate.value === explicitValue);
    if (!profile || profile.topology === 'UNKNOWN') {
      throw new WorkerAdapterError(
        'REASONING_PROFILE_UNSUPPORTED',
        `Codex reasoning profile is unsupported for model ${model.id}.`
      );
    }
    return profile;
  }

  for (let index = profiles.length - 1; index >= 0; index -= 1) {
    const profile = profiles[index];
    if (profile.topology === 'UNKNOWN') {
      throw new WorkerAdapterError(
        'REASONING_PROFILE_UNSUPPORTED',
        `Codex reasoning topology is unknown for model ${model.id}.`
      );
    }
    if (profile.topology === 'ORDINARY') return profile;
  }

  throw new WorkerAdapterError(
    'REASONING_PROFILE_UNSUPPORTED',
    `Codex model has no supported ordinary reasoning profile: ${model.id}`
  );
}
