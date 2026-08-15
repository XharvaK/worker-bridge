import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IpcServer } from '../../src/service/ipc-server.js';
import { IpcClient } from '../../src/service/ipc-client.js';
import { DurableService } from '../../src/service/durable-service.js';
import { ConfigManager } from '../../src/config.js';
import { Ledger } from '../../src/engine/ledger.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { JobManager } from '../../src/service/job-manager.js';
import { StartJobResult, ListTargetsResult, GetJobResult } from '../../src/service/ipc-protocol.js';

describe('IPC Server and Client with Durable Service', () => {
  let tmpDir: string;
  let pipePath: string;
  let projectDir: string;
  let server: DurableService;
  let client: IpcClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    pipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\worker-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : path.join(tmpDir, 'test-bridge.sock');

    const configManager = new ConfigManager({
      mailboxRepoPath: path.join(tmpDir, 'mailbox'),
      workerRootDir: path.join(tmpDir, 'workers'),
      allowedProjects: {},
      selectionPolicy: {
        targets: {
          test_target: {
            targetId: 'test_target',
            platformId: 'antigravity',
            modelId: 'gemini-3.7-flash',
            displayName: 'Test Target',
            reasoning: { strategy: 'highest-supported' },
          },
        },
        roleRankings: {
          PLANNER: ['test_target'],
          WORKER: ['test_target'],
          INVESTIGATOR: ['test_target'],
          REVIEWER: ['test_target'],
        },
      },
    });

    const ledger = new Ledger(path.join(tmpDir, 'ledger.json'));
    const availabilityLedger = new TargetAvailabilityLedger(path.join(tmpDir, 'avail.json'));
    const jobManager = new JobManager({ trustedRoots: [tmpDir] });

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
    await client.close();
    await server.stop();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists targets via list_targets IPC method', async () => {
    const res = await client.call<ListTargetsResult>('list_targets');
    expect(res.targets).toBeInstanceOf(Array);
    expect(res.targets.length).toBeGreaterThanOrEqual(1);
    expect(res.targets.find((t) => t.targetId === 'test_target')).toBeTruthy();
  });

  it('creates and retrieves a job via start_job and get_job IPC methods', async () => {
    const startRes = await client.call<StartJobResult>('start_job', {
      clientRequestId: 'ipc-req-001',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'IPC plan test',
    });

    expect(startRes.jobId).toBeTruthy();
    expect(startRes.state).toBe('PENDING');

    const getRes = await client.call<GetJobResult>('get_job', {
      jobId: startRes.jobId,
    });

    expect(getRes.jobId).toBe(startRes.jobId);
    expect(getRes.state).toBe('PENDING');
  });

  it('cancels a job via cancel_job IPC method', async () => {
    const startRes = await client.call<StartJobResult>('start_job', {
      clientRequestId: 'ipc-req-cancel',
      projectPath: projectDir,
      intent: 'plan',
      executionMode: 'READ_ONLY',
      goal: 'Cancel test',
    });

    const cancelRes = await client.call<any>('cancel_job', {
      jobId: startRes.jobId,
    });

    expect(cancelRes.previousState).toBe('PENDING');
    expect(cancelRes.newState).toBe('CANCELLED');
  });

  it('handles unknown IPC methods cleanly with error response', async () => {
    await expect(client.call('non_existent_method' as any)).rejects.toThrow('UNKNOWN_METHOD');
  });
});
