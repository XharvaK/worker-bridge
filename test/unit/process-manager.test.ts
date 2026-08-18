import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ProcessManager } from '../../src/engine/process-manager.js';

describe('ProcessManager bounded evidence capture', () => {
  it('delivers exact stdin text, closes stdin, and preserves bounded output', async () => {
    const manager = new ProcessManager();
    const result = await manager.run('stdin-delivery-test', {
      executable: process.execPath,
      args: ['-e', "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, ended: true })));"],
      cwd: process.cwd(),
      stdinText: 'bounded prompt',
      timeoutSeconds: 10,
      maxOutputBytes: 128,
    });

    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({ input: 'bounded prompt', ended: true });
  });

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

  describe('termination evidence', () => {
    it('confirms TERMINATED when the tracked process tree is killed', async () => {
      const manager = new ProcessManager();
      const running = manager.run('termination-evidence-test', {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
        timeoutSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const outcome = await manager.terminateJob('termination-evidence-test');
      expect(outcome).toBe('TERMINATED');

      const result = await running;
      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('reports NO_ACTIVE_PROCESS for an untracked job id', async () => {
      const manager = new ProcessManager();
      const outcome = await manager.terminateJob('never-tracked-job');
      expect(outcome).toBe('NO_ACTIVE_PROCESS');
    });

    it('reports NO_ACTIVE_PROCESS for a tracked job whose process already exited', async () => {
      const manager = new ProcessManager();
      const result = await manager.run('already-exited-test', {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        timeoutSeconds: 10,
      });
      expect(result.exitCode).toBe(0);

      const outcome = await manager.terminateJob('already-exited-test');
      expect(outcome).toBe('NO_ACTIVE_PROCESS');
    });

    it('never surfaces a killed child as a clean exit', async () => {
      const manager = new ProcessManager();
      const running = manager.run('killed-exit-code-test', {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
        timeoutSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const outcome = await manager.terminateJob('killed-exit-code-test');
      expect(outcome).toBe('TERMINATED');

      const result = await running;
      expect(result.exitCode === 0).toBe(false);
      expect(result.stdout).toBe('');
    });

    it('kills a child process tree via taskkill on Windows', { timeout: 30000 }, async () => {
      const manager = new ProcessManager();
      const running = manager.run('tree-kill-test', {
        executable: process.execPath,
        args: ['-e', 'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
        timeoutSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const outcome = await manager.terminateJob('tree-kill-test');
      expect(outcome).toBe('TERMINATED');
      const result = await running;
      expect(result.exitCode === 0).toBe(false);
    });
  });
});
