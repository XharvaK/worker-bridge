import { describe, it, expect } from 'vitest';
import { sanitizeSecrets } from '../../src/utils/sanitizer.js';

describe('sanitizeSecrets', () => {
  it('redacts GitHub personal access tokens and OAuth tokens', () => {
    const raw = 'Token is gho_abcdefghijklmnopqrstuvwxyz123456 and pat github_pat_11AAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const sanitized = sanitizeSecrets(raw);
    expect(sanitized).not.toContain('gho_abcdefghijklmnopqrstuvwxyz123456');
    expect(sanitized).not.toContain('github_pat_11AAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(sanitized).toContain('[REDACTED_GITHUB_PAT]');
  });

  it('redacts Bearer authorization headers', () => {
    const raw = 'Authorization: Bearer ya29.a0AfH6SMD_random_token_string_here';
    const sanitized = sanitizeSecrets(raw);
    expect(sanitized).not.toContain('ya29.a0AfH6SMD');
    expect(sanitized).toContain('Authorization: Bearer [REDACTED_BEARER_TOKEN]');
  });

  it('redacts Google API keys', () => {
    const raw = 'key=AIzaSyA_1234567890abcdefghijklmnopqrstuv';
    const sanitized = sanitizeSecrets(raw);
    expect(sanitized).not.toContain('AIzaSyA_1234567890');
    expect(sanitized).toContain('[REDACTED_GOOGLE_API_KEY]');
  });

  it('preserves clean text without secrets', () => {
    const raw = 'Build succeeded. 42 tests passed.';
    expect(sanitizeSecrets(raw)).toBe(raw);
  });
});
