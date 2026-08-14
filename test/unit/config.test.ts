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
    expect(config.selectionPolicy?.roleRankings.PLANNER?.[1]).toBe('agy_gemini_flash_37_high');
    expect(config.selectionPolicy?.targets.agy_gemini_flash_37_high.modelId).toBe('gemini-3.7-flash-high');
    expect(config.selectionPolicy?.targets.gemini_flash_legacy).toBeUndefined();
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
          PLANNER: ['custom_target'],
          INVESTIGATOR: ['custom_target'],
          WORKER: ['custom_target'],
          REVIEWER: ['custom_target'],
        },
      },
    });

    expect(config.selectionPolicy?.roleRankings.PLANNER).toEqual(['custom_target']);
    expect(config.selectionPolicy?.targets.custom_target.platformId).toBe('custom');
  });

  it('maps intents to the four configured worker roles', () => {
    expect(roleForJob('plan')).toBe('PLANNER');
    expect(roleForJob('design')).toBe('PLANNER');
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
