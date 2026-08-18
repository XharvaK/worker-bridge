import { describe, it, expect } from 'vitest';
import { ConfigManager, validateConfig } from '../../src/config.js';
import { roleForJob } from '../../src/engine/job-role.js';

describe('ConfigManager & validateConfig', () => {
  const validConfig = {
    mailboxRepoPath: 'C:\\test\\mailbox',
    workerRootDir: 'C:\\test\\workers',
    agyExecutable: 'C:\\test\\bin\\agy.cmd',
    workerModel: 'flash',
    pushWorkerBranches: true,
    notificationsEnabled: true,
    allowedProjects: {
      ashley: {
        path: 'C:\\test\\ashley',
        allowed: true,
      },
      disabledProject: {
        path: 'C:\\test\\disabled',
        allowed: false,
      },
    },
  };

  it('validates a valid configuration object', () => {
    const config = validateConfig(validConfig);
    expect(config.workerModel).toBe('flash');
    expect(config.pushWorkerBranches).toBe(true);
    expect(config.selectionPolicy?.roleRankings.INVESTIGATOR?.[0]).toBe('cursor_grok_46_xhigh');
    expect(config.selectionPolicy?.targets.agy_gemini_flash_37_high.modelId).toBe('gemini-3.7-flash-high');
    expect(config.selectionPolicy?.targets.gemini_flash_legacy).toBeUndefined();
  });

  it('keeps Codex explicit-only target outside automatic ranking while ranking codex_luna_max in WORKER', () => {
    const config = validateConfig(validConfig);
    const codex = config.selectionPolicy?.targets.codex_explicit;

    expect(codex).toMatchObject({
      targetId: 'codex_explicit',
      platformId: 'codex',
      explicitOnly: true,
      modelBinding: 'EXPLICIT_DISCOVERED',
    });
    expect(codex?.modelId).toBeUndefined();
    expect(codex?.aliases).toEqual(['codex', 'openai_codex']);
    expect(config.platforms?.codex).toEqual({ enabled: true, executable: 'codex' });
    expect(config.selectionPolicy?.roleRankings).toEqual({
      INVESTIGATOR: [
        'cursor_grok_46_xhigh',
        'opencode_nemotron_35_lightning',
        'opencode_deepseek_v4_flash_max',
        'agy_gemini_flash_37_high',
        'opencode_hy3_high',
        'opencode_laguna_s_21_high',
        'opencode_nemotron_3_ultra',
      ],
      WORKER: [
        'codex_luna_max',
        'agy_gemini_flash_37_high',
        'cursor_grok_46_medium',
        'freebuff_default',
        'opencode_nemotron_35_lightning',
        'opencode_deepseek_v4_flash_max',
        'opencode_hy3_high',
        'opencode_laguna_s_21_high',
        'opencode_nemotron_3_ultra',
      ],
      REVIEWER: [
        'opencode_nemotron_35_lightning',
        'cursor_grok_46_xhigh',
        'agy_gemini_flash_37_high',
        'opencode_hy3_high',
        'opencode_deepseek_v4_flash_max',
        'opencode_nemotron_3_ultra',
        'opencode_laguna_s_21_high',
      ],
    });
  });

  it('does not give the explicit Codex target a fixed model or automatic fallback authority', () => {
    const config = validateConfig(validConfig);
    const codex = config.selectionPolicy?.targets.codex_explicit;

    expect(codex?.modelBinding).toBe('EXPLICIT_DISCOVERED');
    expect(codex?.modelId).toBeUndefined();
    expect(codex?.explicitOnly).toBe(true);
    expect(config.platforms?.codex?.defaultModel).toBeUndefined();
    expect(Object.values(config.selectionPolicy?.roleRankings || {}).flat()).not.toContain('codex_explicit');
  });

  it('rejects fixed targets without a model ID and accepts dynamic targets without one', () => {
    expect(() => validateConfig({
      ...validConfig,
      selectionPolicy: {
        targets: {
          fixed_without_model: {
            targetId: 'fixed_without_model',
            platformId: 'custom',
            displayName: 'Fixed Without Model',
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {},
      },
    })).toThrow('modelId');

    const config = validateConfig({
      ...validConfig,
      selectionPolicy: {
        targets: {
          dynamic_target: {
            targetId: 'dynamic_target',
            platformId: 'custom',
            displayName: 'Dynamic Target',
            modelBinding: 'EXPLICIT_DISCOVERED',
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {},
      },
    });
    expect(config.selectionPolicy?.targets.dynamic_target.modelId).toBeUndefined();
  });

  it('preserves role rankings supplied by local policy data', () => {
    const config = validateConfig({
      ...validConfig,
      selectionPolicy: {
        targets: {
          custom_target: {
            targetId: 'custom_target',
            platformId: 'custom',
            modelId: 'custom/model',
            displayName: 'Custom Model',
            aliases: ['custom'],
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {
          INVESTIGATOR: ['custom_target'],
          WORKER: ['custom_target'],
          REVIEWER: ['custom_target'],
        },
      },
    });

    expect(config.selectionPolicy?.roleRankings.INVESTIGATOR).toEqual(['custom_target']);
    expect(config.selectionPolicy?.targets.custom_target.platformId).toBe('custom');
  });

  it('maps intents to the three active worker roles', () => {
    expect(roleForJob('plan')).toBe('INVESTIGATOR');
    expect(roleForJob('design')).toBe('INVESTIGATOR');
    expect(roleForJob('investigate')).toBe('INVESTIGATOR');
    expect(roleForJob('implement')).toBe('WORKER');
    expect(roleForJob('fix')).toBe('WORKER');
    expect(roleForJob('review')).toBe('REVIEWER');
    expect(roleForJob('audit')).toBe('REVIEWER');
  });

  it('throws error on missing mailboxRepoPath', () => {
    expect(() => validateConfig({ ...validConfig, mailboxRepoPath: '' })).toThrow(
      'mailboxRepoPath'
    );
  });

  it('throws error on missing workerModel', () => {
    expect(() => validateConfig({ ...validConfig, workerModel: '' })).toThrow(
      'workerModel'
    );
  });

  it('allows allowlisted projects with allowed=true', () => {
    const manager = new ConfigManager(validConfig);
    expect(manager.isProjectAllowed('ashley')).toBe(true);
    expect(manager.validateJobProjectId('ashley')).toEqual({ ok: true });
  });

  it('rejects unlisted or disabled projects', () => {
    const manager = new ConfigManager(validConfig);
    expect(manager.isProjectAllowed('unknown-project')).toBe(false);
    expect(manager.validateJobProjectId('unknown-project').ok).toBe(false);

    expect(manager.isProjectAllowed('disabledProject')).toBe(false);
    expect(manager.validateJobProjectId('disabledProject').ok).toBe(false);
  });
});
