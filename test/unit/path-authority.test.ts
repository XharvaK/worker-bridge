import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalizePath, isPathContained, assertPathContained } from '../../src/utils/path-authority.js';

describe('Path authority and containment', () => {
  let tmpRoot: string;
  let nestedDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-path-authority-'));
    nestedDir = path.join(tmpRoot, 'projects', 'my-repo');
    fs.mkdirSync(nestedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('accepts a normal path under the root', () => {
    expect(isPathContained(nestedDir, [tmpRoot])).toBe(true);
  });

  it('accepts the root itself as contained', () => {
    expect(isPathContained(tmpRoot, [tmpRoot])).toBe(true);
  });

  it('rejects path escape via ..', () => {
    const escaped = path.join(nestedDir, '..', '..', '..', 'etc');
    expect(isPathContained(escaped, [tmpRoot])).toBe(false);
  });

  it('handles case differences on Windows', () => {
    if (process.platform !== 'win32') return;
    const upper = tmpRoot.toUpperCase();
    const lower = tmpRoot.toLowerCase();
    // Both should canonicalize to equivalent paths
    const canon1 = canonicalizePath(upper);
    const canon2 = canonicalizePath(lower);
    expect(canon1.toLowerCase()).toBe(canon2.toLowerCase());
    expect(isPathContained(nestedDir.toLowerCase(), [tmpRoot.toUpperCase()])).toBe(true);
  });

  it('rejects a junction/symlink that resolves outside the root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outside-'));
    const junctionPath = path.join(tmpRoot, 'sneaky-link');
    try {
      fs.symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Skip if symlink creation not supported
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    expect(isPathContained(junctionPath, [tmpRoot])).toBe(false);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('accepts a symlink that resolves inside the root', () => {
    const linkTarget = nestedDir;
    const linkPath = path.join(tmpRoot, 'internal-link');
    try {
      fs.symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // Skip if symlink creation not supported
    }
    expect(isPathContained(linkPath, [tmpRoot])).toBe(true);
  });

  it('rejects UNC paths', () => {
    if (process.platform !== 'win32') return;
    expect(isPathContained('\\\\server\\share\\file', [tmpRoot])).toBe(false);
  });

  it('assertPathContained throws on escape', () => {
    const escaped = path.join(nestedDir, '..', '..', '..', 'etc');
    expect(() => assertPathContained(escaped, [tmpRoot])).toThrow();
  });

  it('assertPathContained does not throw on contained path', () => {
    expect(() => assertPathContained(nestedDir, [tmpRoot])).not.toThrow();
  });

  it('canonicalizePath resolves relative paths', () => {
    const relative = path.join(nestedDir, '..', 'my-repo');
    const canon = canonicalizePath(relative);
    expect(path.isAbsolute(canon)).toBe(true);
  });
});
