import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { OpenCodeAdapter } from '../../src/worker/opencode-adapter.js';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('OpenCodeAdapter & CLI Invariants', () => {
  const processManager = new ProcessManager();
  const mockOpenCode = path.resolve('test/fixtures/mock-opencode.cmd');

  it('builds noninteractive command line arguments with model, variant, format json and auto', () => {
    const adapter = new OpenCodeAdapter('opencode.cmd', 'opencode/deepseek-v4-flash-free', processManager);
    const args = adapter.buildInvocationArgs(
      'Plan architecture',
      'C:\\worktree\\dir',
      'opencode/deepseek-v4-flash-free',
      'max',
      'sess-123'
    );

    expect(args[0]).toBe('run');
    expect(args).toContain('Plan architecture');
    expect(args).toContain('--dir');
    expect(args).toContain('C:\\worktree\\dir');
    expect(args).toContain('-m');
    expect(args).toContain('opencode/deepseek-v4-flash-free');
    expect(args).toContain('--variant');
    expect(args).toContain('max');
    expect(args).toContain('-s');
    expect(args).toContain('sess-123');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('--auto');
  });

  it('inspects and discovers installed OpenCode CLI binary', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/deepseek-v4-flash-free', processManager);
    const env = await adapter.inspectEnvironment();

    expect(env.installed).toBe(true);
    expect(env.version).toBeDefined();
    expect(env.version).toContain('1.18.');
  });

  it('discovers catalog models and extracts highest reasoning variants', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/deepseek-v4-flash-free', processManager);
    const models = await adapter.discoverModels();

    expect(models.length).toBeGreaterThan(0);

    const deepseek = models.find((m) => m.id === 'opencode/deepseek-v4-flash-free');
    expect(deepseek).toBeDefined();
    expect(deepseek?.variants).toContain('max');
    expect(deepseek?.highestVariant).toBe('max');

    const hy3 = models.find((m) => m.id === 'opencode/hy3-free');
    expect(hy3).toBeDefined();
    expect(hy3?.highestVariant).toBe('high');

    const nemotron = models.find((m) => m.id === 'opencode/nemotron-3.5-lightning-free');
    expect(nemotron).toBeDefined();
    expect(nemotron?.highestVariant).toBeUndefined();
  });

  it('resolves highest-supported reasoning variant for model with variants', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/deepseek-v4-flash-free', processManager);
    const variant = await adapter.resolveReasoningProfile('opencode/deepseek-v4-flash-free', 'highest-supported');
    expect(variant).toBe('max');
  });

  it('resolves undefined reasoning variant for model without variants', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/nemotron-3.5-lightning-free', processManager);
    const variant = await adapter.resolveReasoningProfile('opencode/nemotron-3.5-lightning-free', 'highest-supported');
    expect(variant).toBeUndefined();
  });

  it('honors explicit reasoning variant override', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/deepseek-v4-flash-free', processManager);
    const variant = await adapter.resolveReasoningProfile('opencode/deepseek-v4-flash-free', 'explicit', 'low');
    expect(variant).toBe('low');
  });

  it('reports UNKNOWN quota probe state prior to execution', async () => {
    const adapter = new OpenCodeAdapter(mockOpenCode, 'opencode/deepseek-v4-flash-free', processManager);
    const quota = await adapter.probeQuota();
    expect(quota.state).toBe('UNKNOWN');
  });
});
