import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Test execution boundary', () => {
  it('keeps real provider smoke tests out of normal npm test', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toContain('--exclude test/integration/real-smoke.test.ts');
    expect(packageJson.scripts['test:real-smoke']).toContain('test/integration/real-smoke.test.ts');
    expect(packageJson.scripts.test).not.toContain('AntigravityAdapter');
    expect(packageJson.scripts.test).not.toContain('OpenCodeAdapter');
  });
});
