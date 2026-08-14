import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { CodexAdapter } from '../../src/worker/codex-adapter.js';

function configureVersionProbeMock(): void {
  execFileMock.mockImplementation((executable: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    if (executable === 'codex' || executable === 'codex.exe' || executable === 'codex.cmd' || (executable !== 'where.exe' && args.includes('codex.cmd'))) {
      callback(Object.assign(new Error('explicit executable is unavailable'), { code: 'ENOENT' }));
      return;
    }
    if (executable === 'where.exe') {
      callback(null, { stdout: `C:\\fixture\\resolved-${args[0] || 'codex'}`, stderr: '' });
      return;
    }
    callback(null, { stdout: 'codex-cli 0.147.0', stderr: '' });
  });
}

describe('CodexAdapter executable identity', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    configureVersionProbeMock();
  });

  it.each(['codex.exe', 'codex.cmd'])('does not replace explicitly configured %s with a discovery candidate', async (executable) => {
    const adapter = new CodexAdapter(executable);

    const environment = await adapter.inspectEnvironment();

    expect(environment).toMatchObject({
      installed: false,
      executablePath: executable,
    });
    expect(execFileMock.mock.calls).toHaveLength(1);
    expect(execFileMock.mock.calls.some(([file]) => file === 'where.exe')).toBe(false);
    const invocations = execFileMock.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(invocations).toContain(executable);
    expect(adapter.getExecutablePath()).toBe(executable);
  });

  it('does not replace an explicitly configured bare codex name', async () => {
    const adapter = new CodexAdapter('codex');

    const environment = await adapter.inspectEnvironment();

    expect(environment).toMatchObject({ installed: false, executablePath: 'codex' });
    expect(execFileMock.mock.calls).toHaveLength(1);
    expect(execFileMock.mock.calls.some(([file]) => file === 'where.exe')).toBe(false);
    expect(adapter.getExecutablePath()).toBe('codex');
  });

  it('preserves default candidate discovery when the executable argument is omitted', async () => {
    const adapter = new CodexAdapter();

    const environment = await adapter.inspectEnvironment();

    expect(environment).toMatchObject({ installed: true, executablePath: 'C:\\fixture\\resolved-codex.exe' });
    expect(execFileMock.mock.calls.map(([file]) => file)).toEqual(['where.exe', 'codex', 'C:\\fixture\\resolved-codex.exe']);
    expect(adapter.getExecutablePath()).toBe('C:\\fixture\\resolved-codex.exe');
  });
});
