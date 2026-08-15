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

  it('classifies affirmative description-only automatic delegation without using the profile value', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'description-only-delegator',
          display_name: 'Description Only Delegator',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            {
              effort: 'ordinary',
              description: 'Uses automatic delegation to split work into child tasks.',
            },
          ],
        },
      ],
    });

    expect(catalog.models[0]?.reasoningProfiles?.[0]).toMatchObject({
      value: 'ordinary',
      topology: 'TOPOLOGY_CHANGING',
    });
  });

  it('keeps negated, conflicting, and ambiguous delegation descriptions unknown', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'negated-delegation',
          display_name: 'Negated Delegation',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            {
              effort: 'negated',
              description: 'Does not use automatic delegation; delegated work is excluded.',
            },
          ],
        },
        {
          slug: 'conflicting-delegation',
          display_name: 'Conflicting Delegation',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            {
              effort: 'conflicting',
              description: 'Uses automatic delegation, but standard ordinary reasoning is required.',
            },
          ],
        },
        {
          slug: 'ambiguous-delegation',
          display_name: 'Ambiguous Delegation',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            {
              effort: 'ambiguous',
              description: 'Delegated work may occur depending on context.',
            },
          ],
        },
      ],
    });

    expect(catalog.models.map((model) => model.reasoningProfiles?.[0]?.topology)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
  });

  it('fails closed when an unknown profile appears above an ordinary candidate', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'unknown-above-ordinary',
          display_name: 'Unknown Above Ordinary',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            {
              effort: 'max',
              description: 'Standard ordinary reasoning.',
              topology: 'ordinary',
            },
            {
              effort: 'provider-defined',
              description: 'Delegated work may occur depending on policy.',
            },
          ],
        },
      ],
    });

    expect(() => resolveCodexReasoningProfile(catalog.models[0]!, 'highest-supported')).toThrow(
      'REASONING_PROFILE_UNSUPPORTED'
    );
  });

  it('fails closed for unknown or unsupported reasoning topology', () => {
    const catalog = parseCodexModelCatalog(fixture);
    const unknownModel = catalog.models.find((model) => model.id === 'codex-unknown-topology');
    const luna = catalog.models.find((model) => model.id === 'gpt-5.6-luna');
    const sol = catalog.models.find((model) => model.id === 'gpt-5.6-sol');

    expect(() => resolveCodexReasoningProfile(unknownModel!, 'highest-supported')).toThrow('REASONING_PROFILE_UNSUPPORTED');
    expect(() => resolveCodexReasoningProfile(unknownModel!, 'explicit', 'high')).toThrow('REASONING_PROFILE_UNSUPPORTED');
    expect(() => resolveCodexReasoningProfile(sol!, 'explicit', 'not-real')).toThrow('REASONING_PROFILE_UNSUPPORTED');

    // Luna with max effort resolves successfully
    expect(resolveCodexReasoningProfile(luna!, 'explicit', 'max').value).toBe('max');
  });

  it('selects the highest ordinal regardless of array order', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'unordered-model',
          display_name: 'Unordered Model',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            { effort: 'high', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
            { effort: 'low', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
            { effort: 'medium', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
          ],
        },
      ],
    });
    expect(resolveCodexReasoningProfile(catalog.models[0]!, 'highest-supported').value).toBe('high');
  });

  it('fails closed when an ordinary profile has an unrecognized effort value', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'unknown-effort-model',
          display_name: 'Unknown Effort',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
            { effort: 'turbo', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
          ],
        },
      ],
    });
    expect(() => resolveCodexReasoningProfile(catalog.models[0]!, 'highest-supported')).toThrow(
      'REASONING_PROFILE_UNSUPPORTED'
    );
  });

  it('deduplicates profiles with the same effort value', () => {
    const catalog = parseCodexModelCatalog({
      models: [
        {
          slug: 'duplicate-effort-model',
          display_name: 'Duplicate Effort',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [
            { effort: 'high', description: 'Standard ordinary reasoning.', topology: 'ordinary' },
            { effort: 'high', description: 'Same again.', topology: 'ordinary' },
          ],
        },
      ],
    });
    expect(resolveCodexReasoningProfile(catalog.models[0]!, 'highest-supported').value).toBe('high');
  });

  it('rejects catalogs with duplicate model IDs', () => {
    expect(() =>
      parseCodexModelCatalog({
        models: [
          { slug: 'same-id', display_name: 'First', visibility: 'list', supported_reasoning_levels: [] },
          { slug: 'same-id', display_name: 'Second', visibility: 'list', supported_reasoning_levels: [] },
        ],
      })
    ).toThrow('MODEL_DISCOVERY_UNAVAILABLE');
  });

  it('fails closed when profiles have no effort field', () => {
    expect(() =>
      parseCodexModelCatalog({
        models: [
          {
            slug: 'no-effort-model',
            display_name: 'No Effort',
            visibility: 'list',
            supported_in_api: true,
            supported_reasoning_levels: [{ description: 'Missing effort field.', topology: 'ordinary' }],
          },
        ],
      })
    ).toThrow('MODEL_DISCOVERY_UNAVAILABLE');
  });
});
