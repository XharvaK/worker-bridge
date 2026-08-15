import { describe, it, expect } from 'vitest';
import { filterEnv, CODEX_ENV_POLICY, AGY_ENV_POLICY, OPENCODE_ENV_POLICY } from '../../src/utils/env-filter.js';

describe('Per-platform environment variable filtering', () => {
  const mockEnv: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    USERPROFILE: 'C:\\Users\\User',
    OPENAI_API_KEY: 'sk-test-key-12345',
    ANTHROPIC_API_KEY: 'sk-ant-test-key-67890',
    GROQ_API_KEY: 'gsk-test-key',
    MISTRAL_API_KEY: 'msk-test-key',
    CODEX_HOME: 'C:\\Users\\User\\.codex',
    HTTPS_PROXY: 'http://proxy:8080',
    NODE_ENV: 'production',
    LANG: 'en_US.UTF-8',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    TEMP: 'C:\\Users\\User\\AppData\\Local\\Temp',
    SECRET_THING: 'should-not-appear',
    MY_CUSTOM_VAR: 'custom-value',
  };

  it('Codex policy includes OPENAI_API_KEY and CODEX_ prefixed vars', () => {
    const filtered = filterEnv(CODEX_ENV_POLICY, mockEnv);
    expect(filtered.OPENAI_API_KEY).toBe('sk-test-key-12345');
    expect(filtered.CODEX_HOME).toBe('C:\\Users\\User\\.codex');
  });

  it('Codex policy excludes cross-provider API keys', () => {
    const filtered = filterEnv(CODEX_ENV_POLICY, mockEnv);
    expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
    expect(filtered.GROQ_API_KEY).toBeUndefined();
    expect(filtered.MISTRAL_API_KEY).toBeUndefined();
    expect(filtered.SECRET_THING).toBeUndefined();
    expect(filtered.MY_CUSTOM_VAR).toBeUndefined();
  });

  it('always includes essential path and user variables', () => {
    const filtered = filterEnv(CODEX_ENV_POLICY, mockEnv);
    expect(filtered.PATH).toBe('/usr/bin');
    expect(filtered.HOME).toBe('/home/user');
    expect(filtered.USERPROFILE).toBe('C:\\Users\\User');
    expect(filtered.NODE_ENV).toBe('production');
    expect(filtered.LANG).toBe('en_US.UTF-8');
  });

  it('includes proxy variables', () => {
    const filtered = filterEnv(CODEX_ENV_POLICY, mockEnv);
    expect(filtered.HTTPS_PROXY).toBe('http://proxy:8080');
  });

  it('all three platform policies export valid structures', () => {
    expect(CODEX_ENV_POLICY.allowedPrefixes).toContain('OPENAI_');
    expect(CODEX_ENV_POLICY.allowedPrefixes).toContain('CODEX_');
    expect(AGY_ENV_POLICY.allowedPrefixes).toContain('GOOGLE_');
    expect(OPENCODE_ENV_POLICY.allowedPrefixes).toContain('OPENCODE_');
    // None should include cross-provider prefixes
    expect(CODEX_ENV_POLICY.allowedPrefixes).not.toContain('ANTHROPIC_');
    expect(AGY_ENV_POLICY.allowedPrefixes).not.toContain('OPENAI_');
  });
});
