import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockedExistsSync, mockedExecFile } = vi.hoisted(() => ({
  mockedExistsSync: vi.fn(),
  mockedExecFile: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mockedExistsSync,
    readFileSync: vi.fn(() => {
      throw new Error('no such file');
    }),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

import { FreebuffAdapter } from '../../src/worker/freebuff-adapter.js';

function expectedNativeBinaryPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.config', 'manicode', process.platform === 'win32' ? 'freebuff.exe' : 'freebuff');
}

afterEach(() => {
  mockedExistsSync.mockReset();
  mockedExecFile.mockReset();
});

describe('FreebuffAdapter version operational truth', () => {
  it('never invents a version when package metadata, Freebuff metadata, and executable version output are all unavailable', async () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecFile.mockImplementation((_exe: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('spawn failed'));
    });

    const adapter = new FreebuffAdapter('freebuff');
    const env = await adapter.inspectEnvironment();

    expect(env.installed).toBe(false);
    expect(env.version).toBeUndefined();
  });

  it('reports installed but version undefined when the binary exists but --version cannot be established', async () => {
    const nativePath = expectedNativeBinaryPath();
    mockedExistsSync.mockImplementation((p: string) => p === nativePath);
    mockedExecFile.mockImplementation((_exe: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('spawn failed'));
    });

    const adapter = new FreebuffAdapter('freebuff');
    const env = await adapter.inspectEnvironment();

    // Binary presence establishes installation, never executability or a version.
    expect(env.installed).toBe(true);
    expect(env.version).toBeUndefined();
    expect(env.executablePath).toBe(nativePath);
  });
});