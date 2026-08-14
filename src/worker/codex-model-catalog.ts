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

function classifyExplicitTopology(profile: Record<string, unknown>): ReasoningTopology | undefined {
  const values = [profile.topology, profile.reasoning_topology, profile.topology_class].filter(
    (value) => value !== undefined
  );
  if (values.length === 0) return undefined;

  const normalized = values.map(normalizeTopologyValue);
  if (normalized.some((topology) => topology === undefined)) return 'UNKNOWN';

  const first = normalized[0];
  return normalized.every((topology) => topology === first) ? first : 'UNKNOWN';
}

function classifyDescriptionTopology(descriptionValue: unknown): {
  topology: ReasoningTopology;
  hasTopologyMarker: boolean;
} {
  if (typeof descriptionValue !== 'string' || !descriptionValue.trim()) {
    return { topology: 'UNKNOWN', hasTopologyMarker: false };
  }

  const description = descriptionValue.toLowerCase().replace(/\s+/g, ' ').trim();
  const delegationMention =
    /\b(?:automatic\s+delegation|delegated\s+work|automatically\s+delegat(?:e|es|ed|ing)\s+(?:work|tasks?))\b/.test(
      description
    );
  const ordinaryMention = /\b(?:standard\s+ordinary|standard|ordinary)\s+reasoning\b/.test(description);
  const hasTopologyMarker = delegationMention || ordinaryMention;
  if (!hasTopologyMarker) return { topology: 'UNKNOWN', hasTopologyMarker: false };

  const hasNegationOrUncertainty =
    /\b(?:not|never|no|without|does\s+not|do\s+not|doesn't|don't|isn't|aren't|cannot|can't|may|might|could|possibly|potentially|depending|whether|if)\b/.test(
      description
    );
  const affirmativeDelegation =
    /\b(?:uses?|performs?|enables?|supports?|provides?|allows?)\s+(?:automatic\s+delegation|delegated\s+work)\b/.test(
      description
    ) ||
    /\b(?:automatic\s+delegation|delegated\s+work)\s+(?:is|are)\s+(?:enabled|active|used|supported|available)\b/.test(
      description
    ) ||
    /\bautomatically\s+delegat(?:e|es|ed|ing)\s+(?:work|tasks?)\b/.test(description);

  if (hasNegationOrUncertainty || (delegationMention && ordinaryMention)) {
    return { topology: 'UNKNOWN', hasTopologyMarker: true };
  }
  if (delegationMention) {
    return {
      topology: affirmativeDelegation ? 'TOPOLOGY_CHANGING' : 'UNKNOWN',
      hasTopologyMarker: true,
    };
  }
  return { topology: 'ORDINARY', hasTopologyMarker: true };
}

function classifyReasoningTopology(profile: Record<string, unknown>): ReasoningTopology {
  const explicit = classifyExplicitTopology(profile);
  const described = classifyDescriptionTopology(profile.description);

  if (explicit === 'UNKNOWN') return 'UNKNOWN';
  if (explicit && described.hasTopologyMarker && described.topology !== explicit) return 'UNKNOWN';
  return explicit ?? described.topology;
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
