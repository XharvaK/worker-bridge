import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/mock-codex-catalog.json' with { type: 'json' };
import {
  assertCodexModelSelectable,
  parseCodexModelCatalog,
  resolveCodexReasoningProfile,
} from '../../src/worker/codex-model-catalog.js';

describe('Codex model catalog parsing', () => {
  it('parses exact catalog IDs, display names, source, and native reasoning values', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const sol = catalog.models.find((model) => model.id === 'gpt-5.6-sol');

    expect(catalog.source).toBe('bundled');
    expect(catalog.models.map((model) => model.id)).toContain('codex-auto-review');
    expect(sol).toMatchObject({
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      variants: [],
      selectability: 'SELECTABLE',
    });
    expect(sol?.reasoningProfiles?.map((profile) => profile.value)).toEqual(['low', 'max', 'ultra']);
  });

  it('normalizes selectability from visibility and supported_in_api metadata', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const byId = new Map(catalog.models.map((model) => [model.id, model.selectability]));

    expect(byId.get('gpt-5.6-sol')).toBe('SELECTABLE');
    expect(byId.get('codex-auto-review')).toBe('NOT_SELECTABLE');
    expect(byId.get('codex-api-disabled')).toBe('NOT_SELECTABLE');
    expect(byId.get('codex-unknown-selectability')).toBe('UNKNOWN');
  });

  it('rejects hidden and unknown-selectability models by metadata without a model ID denylist', () => {
    const hiddenOnly = parseCodexModelCatalog({
      models: [
        {
          slug: 'new-hidden-model',
          display_name: 'New Hidden Model',
          visibility: 'hide',
          supported_reasoning_levels: [],
        },
        {
          slug: 'new-unknown-model',
          display_name: 'New Unknown Model',
          supported_reasoning_levels: [],
        },
      ],
    });

    expect(hiddenOnly.models[0]?.selectability).toBe('NOT_SELECTABLE');
    expect(() => assertCodexModelSelectable(hiddenOnly.models[0]!)).toThrow('MODEL_NOT_SELECTABLE');
    expect(hiddenOnly.models[1]?.selectability).toBe('UNKNOWN');
    expect(() => assertCodexModelSelectable(hiddenOnly.models[1]!)).toThrow('MODEL_NOT_SELECTABLE');
  });

  it('fails closed when the catalog shape is absent or malformed', () => {
    expect(() => parseCodexModelCatalog({})).toThrow('MODEL_DISCOVERY_UNAVAILABLE');
    expect(() => parseCodexModelCatalog({ models: {} })).toThrow('MODEL_DISCOVERY_UNAVAILABLE');
    expect(() => parseCodexModelCatalog({ models: [{ slug: 42 }] })).toThrow('MODEL_DISCOVERY_UNAVAILABLE');
  });

  it('selects the highest provider-ordered ordinary profile while skipping known topology changes', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const sol = catalog.models.find((model) => model.id === 'gpt-5.6-sol');
    const terra = catalog.models.find((model) => model.id === 'gpt-5.6-terra');

    expect(resolveCodexReasoningProfile(sol!, 'highest-supported').value).toBe('max');
    expect(resolveCodexReasoningProfile(terra!, 'highest-supported').value).toBe('max');
  });

  it('returns explicit topology-changing reasoning for later authority-envelope validation', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const sol = catalog.models.find((model) => model.id === 'gpt-5.6-sol');

    expect(resolveCodexReasoningProfile(sol!, 'explicit', 'ultra')).toMatchObject({
      value: 'ultra',
      topology: 'TOPOLOGY_CHANGING',
    });
  });

  it('fails closed for unknown or unsupported reasoning topology', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const luna = catalog.models.find((model) => model.id === 'gpt-5.6-luna');
    const sol = catalog.models.find((model) => model.id === 'gpt-5.6-sol');

    expect(() => resolveCodexReasoningProfile(luna!, 'highest-supported')).toThrow('REASONING_PROFILE_UNSUPPORTED');
    expect(() => resolveCodexReasoningProfile(luna!, 'explicit', 'high')).toThrow('REASONING_PROFILE_UNSUPPORTED');
    expect(() => resolveCodexReasoningProfile(sol!, 'explicit', 'not-real')).toThrow('REASONING_PROFILE_UNSUPPORTED');
  });
});
