import { describe, it, expect } from 'vitest';
import { AntigravityAdapter } from '../../src/worker/agy-adapter.js';
import { OpenCodeAdapter } from '../../src/worker/opencode-adapter.js';
import { ProcessManager, ProcessRunOptions, ProcessRunResult } from '../../src/engine/process-manager.js';

class StubProcessManager extends ProcessManager {
  constructor(private readonly result: ProcessRunResult) {
    super();
  }

  override async run(_jobId: string, _options: ProcessRunOptions): Promise<ProcessRunResult> {
    return this.result;
  }
}

const request = {
  jobId: `adapter-evidence-${Date.now()}`,
  roundNumber: 1,
  executionMode: 'READ_ONLY' as const,
  worktreeCwd: process.cwd(),
  promptText: 'Inspect the fixture.',
  modelId: 'fixture-model',
  variant: 'high',
  timeoutSeconds: 10,
};

describe('Adapter evidence propagation', () => {
  it('preserves bounded Antigravity failure evidence and retryAt', async () => {
    const adapter = new AntigravityAdapter(
      'fixture-agy',
      'fixture-model',
      new StubProcessManager({
        exitCode: 1,
        stdout: 'partial AGY response',
        stderr: 'quota exhausted; retry-after: 30 seconds',
        timedOut: false,
        pid: 123,
        outputTruncated: false,
      })
    );

    const result = await adapter.invokeWorker(request);
    expect(result.failureClass).toBe('QUOTA_EXHAUSTED');
    expect(result.retryAt).toBeDefined();
    expect(result.evidence?.partialResponse).toContain('partial AGY response');
    expect(result.evidence?.lastMeaningfulAction).toContain('partial AGY response');
  });

  it('preserves OpenCode session and structured event evidence', async () => {
    const adapter = new OpenCodeAdapter(
      'fixture-opencode',
      'fixture-model',
      new StubProcessManager({
        exitCode: 0,
        stdout: '{"sessionID":"sess-123","type":"tool","tool":"read"}\n{"type":"text","text":"partial response"}',
        stderr: '',
        timedOut: false,
        pid: 456,
        outputTruncated: false,
      })
    );

    const result = await adapter.invokeWorker(request);
    expect(result.platformSessionId).toBe('sess-123');
    expect(result.evidence?.toolSummary?.read).toBe(1);
    expect(result.evidence?.partialResponse).toContain('partial response');
  });
});
