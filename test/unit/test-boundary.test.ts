import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Test execution boundary', () => {
  it('keeps real provider smoke tests out of normal npm test', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const read = (filePath: string) => fs.readFileSync(path.resolve(filePath), 'utf8');
    const readJson = (filePath: string) => JSON.parse(read(filePath)) as Record<string, unknown>;

    expect(packageJson.scripts.test).toContain('--exclude test/integration/real-smoke.test.ts');
    expect(packageJson.scripts['test:real-smoke']).toContain('test/integration/real-smoke.test.ts');
    expect(packageJson.scripts.test).not.toContain('AntigravityAdapter');
    expect(packageJson.scripts.test).not.toContain('OpenCodeAdapter');
    expect(packageJson.scripts.test.toLowerCase()).not.toContain('codex');
    expect(Object.keys(packageJson.scripts).filter((name) => /real|smoke|provider/i.test(name))).toEqual(['test:real-smoke']);

    const readme = read('README.md');
    const cli = read('src/index.ts');
    expect(readme).toContain('Codex');
    expect(readme).toContain('explicit-only');
    expect(readme).toContain('codex_explicit');
    expect(readme).toContain('--ignore-user-config');
    expect(readme).toContain('MODEL_NOT_SELECTABLE');
    expect(cli).toContain('Codex');
    expect(cli).toContain('explicit-only');

    for (const policyPath of ['src/policy/default-selection-policy.json', 'config.example.json']) {
      const policy = readJson(policyPath) as {
        selectionPolicy?: { roleRankings?: Record<string, string[]> };
      };
      for (const ranking of Object.values(policy.selectionPolicy?.roleRankings || {})) {
        expect(ranking).not.toContain('codex_explicit');
      }
    }
  });
});
