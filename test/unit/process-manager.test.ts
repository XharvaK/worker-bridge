import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('ProcessManager bounded evidence capture', () => {
  it('retains bounded beginning/end output and reports truncation', async () => {
    const manager = new ProcessManager();
    const result = await manager.run('bounded-output-test', {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('A'.repeat(500)); process.stderr.write('B'.repeat(500));"],
      cwd: process.cwd(),
      timeoutSeconds: 10,
      maxOutputBytes: 128,
    });

    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stderr.length).toBeLessThanOrEqual(128);
    expect(result.stdout).toContain('A');
    expect(result.stderr).toContain('B');
  });

  it.runIf(process.platform === 'win32')('passes hostile batch arguments as data, not shell syntax', async () => {
    const manager = new ProcessManager();
    const mockOpenCode = path.resolve('test/fixtures/mock-opencode.cmd');
    const hostile = 'safe & echo SHELL_INJECTION_MARKER';
    const result = await manager.run('batch-argument-safety-test', {
      executable: mockOpenCode,
      args: ['--echo-args', hostile],
      cwd: process.cwd(),
      timeoutSeconds: 10,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(JSON.stringify(['--echo-args', hostile]));
  });
});
