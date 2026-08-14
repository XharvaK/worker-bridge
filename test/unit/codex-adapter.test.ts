import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessManager, ProcessRunOptions, ProcessRunResult } from '../../src/engine/process-manager.js';
import { CodexAdapter } from '../../src/worker/codex-adapter.js';

const fixtureExecutable = path.resolve('test/fixtures/mock-codex.cmd');
const temporaryRoots: string[] = [];

function worktree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-bridge-codex-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CodexAdapter fixture-backed CLI contract', () => {
  it('builds exact isolated initial and resume argv without dangerous bypasses', () => {
    const cwd = worktree();
    const adapter = new CodexAdapter(fixtureExecutable);
    const initial = adapter.buildInvocationArgs({
      jobId: 'argv-job', roundNumber: 1, executionMode: 'WORKTREE_WRITE', worktreeCwd: cwd,
      promptText: 'prompt', modelId: 'gpt-5.6-sol', variant: 'max',
    }, 'max');
    expect(initial).toEqual([
      'exec', '--ignore-user-config', '--cd', cwd, '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="max"',
      '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--json', '--output-last-message',
      path.join(cwd, '.worker-bridge-output', 'argv-job-1.txt'), '-',
    ]);
    expect(initial).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(initial).not.toContain('--full-auto');

    const resume = adapter.buildInvocationArgs({
      jobId: 'argv-job', roundNumber: 2, executionMode: 'WORKTREE_WRITE', worktreeCwd: cwd,
      promptText: 'prompt', modelId: 'gpt-5.6-sol', variant: 'max', sessionId: 'session-1',
    }, 'max');
    expect(resume.slice(0, 5)).toEqual(['exec', 'resume', 'session-1', '--ignore-user-config', '--model']);
    expect(resume).not.toContain('--last');
    expect(resume).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('verifies the explicitly configured fixture and reports its native version', async () => {
    const adapter = new CodexAdapter(fixtureExecutable);

    await expect(adapter.inspectEnvironment()).resolves.toMatchObject({
      platformId: 'codex',
      installed: true,
      version: 'codex-cli 0.147.0',
      executablePath: fixtureExecutable,
    });
  });

  it('discovers only the bundled catalog and preserves dynamic model metadata', async () => {
    const adapter = new CodexAdapter(fixtureExecutable);

    const models = await adapter.discoverModels(true);

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'codex-auto-review',
      'codex-api-disabled',
      'codex-unknown-selectability',
    ]);
    expect(models.find((model) => model.id === 'gpt-5.6-sol')).toMatchObject({
      selectability: 'SELECTABLE',
      reasoningProfiles: [
        { value: 'low', topology: 'ORDINARY' },
        { value: 'max', topology: 'ORDINARY' },
        { value: 'ultra', topology: 'TOPOLOGY_CHANGING' },
      ],
    });
    expect(models.find((model) => model.id === 'codex-auto-review')?.selectability).toBe('NOT_SELECTABLE');
  });

  it('resolves exact ordinary native reasoning and rejects unsafe profiles', async () => {
    const adapter = new CodexAdapter(fixtureExecutable);

    await expect(adapter.resolveReasoningProfile('gpt-5.6-sol')).resolves.toBe('max');
    await expect(adapter.resolveReasoningProfile('gpt-5.6-sol', 'explicit', 'max')).resolves.toBe('max');
    await expect(adapter.resolveReasoningProfile('gpt-5.6-sol', 'explicit', 'ultra')).rejects.toThrow(
      'PERMISSION_BLOCKED'
    );
    await expect(adapter.resolveReasoningProfile('gpt-5.6-luna')).rejects.toThrow('REASONING_PROFILE_UNSUPPORTED');
  });

  it('invokes the fixture with isolated exact controls and parses structured evidence', async () => {
    const cwd = worktree();
    const adapter = new CodexAdapter(fixtureExecutable);

    const result = await adapter.invokeWorker({
      jobId: 'job-codex-fixture',
      roundNumber: 1,
      executionMode: 'READ_ONLY',
      worktreeCwd: cwd,
      promptText: 'bounded prompt',
      modelId: 'gpt-5.6-sol',
      variant: 'max',
    });

    expect(result.exitCode).toBe(0);
    expect(result.platformSessionId).toBe('codex-fixture-session-001');
    expect(result.responseText).toContain('fixture response: bounded prompt');
    expect(result.toolSummary).toEqual({ 'fixture.read': 1 });
    expect(result.sessionIdentity).toMatchObject({
      platform: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'max',
      worktreeCwd: cwd,
      executionMode: 'READ_ONLY',
    });
    expect(result.evidence?.lastMeaningfulAction).toBe('tool:fixture.read');
    expect(result.evidence?.stdout).toContain('thread_id');
  });

  it('fails closed before spawning when resume identity is absent', async () => {
    class RecordingProcessManager extends ProcessManager {
      calls = 0;
      override async run(_jobId: string, _options: ProcessRunOptions): Promise<ProcessRunResult> {
        this.calls += 1;
        throw new Error('must not spawn');
      }
    }
    const processManager = new RecordingProcessManager();
    const adapter = new CodexAdapter(fixtureExecutable, processManager);
    await expect(adapter.invokeWorker({
      jobId: 'resume-job', roundNumber: 2, executionMode: 'READ_ONLY', worktreeCwd: worktree(),
      promptText: 'resume', modelId: 'gpt-5.6-sol', variant: 'max', sessionId: 'codex-fixture-session-001',
    })).rejects.toThrow('SESSION_ID_UNAVAILABLE');
    expect(processManager.calls).toBe(0);
  });
});
