import { describe, it, expect } from 'vitest';
import { assertNotProtectedBranch } from '../../src/git/repo-guard.js';

describe('Repo Guard (Branch Protection)', () => {
  it('allows normal worker branches', () => {
    expect(() => assertNotProtectedBranch('worker/ashley/job-001')).not.toThrow();
    expect(() => assertNotProtectedBranch('feature/safe-branch')).not.toThrow();
  });

  it('throws security error on attempts to target master or main', () => {
    const forbidden = ['master', 'main', 'refs/heads/master', 'refs/heads/main', 'origin/master', 'production', 'release'];

    for (const branch of forbidden) {
      expect(() => assertNotProtectedBranch(branch)).toThrow('SECURITY VIOLATION');
    }
  });
});
