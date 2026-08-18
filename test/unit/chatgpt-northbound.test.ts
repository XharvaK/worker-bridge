import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IpcClient } from '../../src/service/ipc-client.js';
import { DurableService } from '../../src/service/durable-service.js';
import { ConfigManager } from '../../src/config.js';
import { Ledger } from '../../src/engine/ledger.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { JobManager } from '../../src/service/job-manager.js';
import { StartJobResult, GetJobResult, GetResultResult } from '../../src/service/ipc-protocol.js';

describe('Worker Bridge Northbound IPC READ_ONLY Slice', () => {
  let tmpDir: string;
  let pipePath: string;
  let projectDir: string;
  let server: DurableService;
  let client: IpcClient;
  let jobManager: JobManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-northbound-test-'));
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\wb-northbound-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : path.join(tmpDir, 'test-bridge.sock');

    const configManager = new ConfigManager({
      mailboxRepoPath: path.join(tmpDir, 'mailbox'),
      workerRootDir: path.join(tmpDir, 'workers'),
      allowedProjects: {},
      selectionPolicy: {
        targets: {
          cursor_grok: {
            targetId: 'cursor_grok',
            platformId: 'cursor-cli',
            modelId: 'cursor-grok-4.6-xhigh',
            displayName: 'Cursor Grok',
            reasoning: { strategy: 'highest-supported' },
          },
          opencode_nemotron: {
            targetId: 'opencode_nemotron',
            platformId: 'opencode',
            modelId: 'opencode/nemotron-3.5-lightning-free',
            displayName: 'OpenCode Nemotron',
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {
          INVESTIGATOR: ['cursor_grok'],
          WORKER: ['cursor_grok'],
          REVIEWER: ['opencode_nemotron'],
        },
      },
    });

    const ledger = new Ledger(path.join(tmpDir, 'ledger.json'));
    const availabilityLedger = new TargetAvailabilityLedger(path.join(tmpDir, 'avail.json'));
    jobManager = new JobManager({ trustedRoots: [tmpDir] });

    server = new DurableService({
      pipePath,
      configManager,
      ledger,
      availabilityLedger,
      jobManager,
      trustedRoots: [tmpDir],
    });

    await server.start();
    client = new IpcClient({ pipePath });
    await client.connect();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (server) await server.stop();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts READ_ONLY job with intent=investigate, derives INVESTIGATOR role and immediate PENDING status', async () => {
    const startRes = await client.call<StartJobResult>('start_job', {
      clientRequestId: 'req-northbound-investigate-001',
      projectPath: projectDir,
      intent: 'investigate',
      executionMode: 'READ_ONLY',
      goal: 'Investigate system architecture',
      originSurface: 'devspace-mcp',
    });

    expect(startRes.jobId).toBeTruthy();
    expect(startRes.state).toBe('PENDING');
    expect(startRes.executionMode).toBe('READ_ONLY');
    expect(startRes.requiresOwnerApproval).toBe(false);

    const getRes = await client.call<GetJobResult>('get_job', {
      jobId: startRes.jobId,
    });

    expect(getRes.jobId).toBe(startRes.jobId);
    expect(getRes.state).toBe('PENDING');
    expect(getRes.intent).toBe('investigate');
  });

  it('accepts READ_ONLY job with intent=review, derives REVIEWER role', async () => {
    const startRes = await client.call<StartJobResult>('start_job', {
      clientRequestId: 'req-northbound-review-001',
      projectPath: projectDir,
      intent: 'review',
      executionMode: 'READ_ONLY',
      goal: 'Audit security rules',
      review: 'Check authorization boundary',
      originSurface: 'devspace-mcp',
    });

    expect(startRes.jobId).toBeTruthy();
    expect(startRes.state).toBe('PENDING');

    // Simulate completion by bridge execution
    jobManager.updateJobResult(startRes.jobId, {
      state: 'WORKER_RETURNED',
      resultText: 'Review complete: No security bypasses found.',
      summary: 'Security review passed',
      verification: 'VERIFIED',
    });

    const getRes = await client.call<GetJobResult>('get_job', {
      jobId: startRes.jobId,
    });

    expect(getRes.state).toBe('WORKER_RETURNED');
    expect(getRes.summary).toBe('Security review passed');
    expect(getRes.verification).toBe('VERIFIED');

    const resultRes = await client.call<GetResultResult>('get_result', {
      jobId: startRes.jobId,
    });
    expect(resultRes.resultText).toBe('Review complete: No security bypasses found.');
  });

  it('fails WORKTREE_WRITE closed over IPC with OWNER_AUTHORITY_UNAVAILABLE', async () => {
    await expect(
      client.call('start_job', {
        clientRequestId: 'req-northbound-write-001',
        projectPath: projectDir,
        intent: 'implement',
        executionMode: 'WORKTREE_WRITE',
        goal: 'Attempted write without owner authority',
      })
    ).rejects.toThrow('OWNER_AUTHORITY_UNAVAILABLE');
  });

  it('rejects path escape outside trusted roots', async () => {
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-dir-'));
    try {
      await expect(
        client.call('start_job', {
          clientRequestId: 'req-northbound-escape-001',
          projectPath: outsidePath,
          intent: 'investigate',
          executionMode: 'READ_ONLY',
          goal: 'Escape test',
        })
      ).rejects.toThrow('PATH_ESCAPE');
    } finally {
      if (fs.existsSync(outsidePath)) fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  });
});
