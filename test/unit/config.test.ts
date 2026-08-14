import { describe, it, expect } from 'vitest';
import { ConfigManager, validateConfig } from '../../src/config.js';

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
