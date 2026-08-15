import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { McpServer, MCP_TOOL_DEFINITIONS } from '../../src/mcp/mcp-server.js';
import { IpcClient } from '../../src/service/ipc-client.js';

class MockIpcClient extends IpcClient {
  calls: Array<{ method: string; params: unknown }> = [];

  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}

  override async call<TResult = unknown>(method: string, params: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === 'list_targets') {
      return { targets: [{ targetId: 'mock_target', platformId: 'antigravity', available: true }] } as TResult;
    }
    if (method === 'start_job') {
      const p = params as any;
      if (p?.executionMode === 'WORKTREE_WRITE') {
        throw new Error('OWNER_AUTHORITY_UNAVAILABLE: WORKTREE_WRITE execution mode is not supported over MCP in v1. MCP is strictly READ_ONLY (plan, investigate, audit, review). Use the GitHub mailbox bridge for owner-authorized WORKTREE_WRITE tasks.');
      }
      return { jobId: 'job-123', state: 'PENDING', executionMode: 'READ_ONLY', requiresOwnerApproval: false } as TResult;
    }
    if (method === 'get_job') {
      return { jobId: 'job-123', state: 'PENDING' } as TResult;
    }
    if (method === 'get_result') {
      return { jobId: 'job-123', resultText: 'output', totalBytes: 6, offset: 0, limit: 32768, hasMore: false } as TResult;
    }
    if (method === 'cancel_job') {
      return { jobId: 'job-123', previousState: 'PENDING', newState: 'CANCELLED' } as TResult;
    }
    if (method === 'prepare_project') {
      return { projectPath: 'C:\\Projects\\repo', status: 'ready', baseSha: 'abc', branch: 'master', clean: true } as TResult;
    }
    throw new Error(`Unhandled mock method: ${method}`);
  }
}

describe('McpServer JSON-RPC stdio protocol', () => {
  let input: PassThrough;
  let output: PassThrough;
  let mockClient: MockIpcClient;
  let server: McpServer;

  beforeEach(async () => {
    input = new PassThrough();
    output = new PassThrough();
    mockClient = new MockIpcClient();

    server = new McpServer({
      ipcClient: mockClient,
      input,
      output,
    });

    await server.start();
  });

  function sendRpc(msg: Record<string, unknown>): Promise<any> {
    return new Promise((resolve) => {
      output.once('data', (chunk) => {
        resolve(JSON.parse(chunk.toString('utf8').trim()));
      });
      input.write(`${JSON.stringify(msg)}\n`);
    });
  }

  it('responds to initialize with protocol version and serverInfo', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe('worker-bridge');
    expect(res.result.serverInfo.version).toBe('2.0.0');
    expect(res.result.capabilities.tools).toBeTruthy();
  });

  it('lists the 6 standard MCP tools via tools/list', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    expect(res.result.tools).toHaveLength(6);
    const toolNames = res.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('worker_bridge_list_targets');
    expect(toolNames).toContain('worker_bridge_start_job');
    expect(toolNames).toContain('worker_bridge_get_job');
    expect(toolNames).toContain('worker_bridge_get_result');
    expect(toolNames).toContain('worker_bridge_cancel_job');
    expect(toolNames).toContain('worker_bridge_prepare_project');
  });

  it('dispatches tools/call for worker_bridge_list_targets', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'worker_bridge_list_targets',
        arguments: {},
      },
    });

    expect(mockClient.calls[0].method).toBe('list_targets');
    expect(res.result.content[0].text).toContain('mock_target');
  });

  it('dispatches worker_bridge_start_job with excludedPlatforms: [cursor-agent] and trusted originSurface', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'worker_bridge_start_job',
        arguments: {
          clientRequestId: 'mcp-req-001',
          projectPath: 'C:\\Projects\\repo',
          intent: 'plan',
          executionMode: 'READ_ONLY',
          goal: 'Plan feature',
          originSurface: 'spoofed-cli', // Malicious spoof attempt
        },
      },
    });

    expect(mockClient.calls[0].method).toBe('start_job');
    const startParams = mockClient.calls[0].params as any;
    expect(startParams.excludedPlatforms).toEqual(['cursor-agent']);
    expect(startParams.originSurface).toBe('cursor-agent');
    expect(startParams.orchestrator).toEqual({
      surface: 'cursor-agent',
      role: 'orchestrator',
      modelHint: undefined,
    });
    expect(res.result.content[0].text).toContain('job-123');
  });

  it('fails WORKTREE_WRITE closed with OWNER_AUTHORITY_UNAVAILABLE and prevents downstream execution', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'worker_bridge_start_job',
        arguments: {
          clientRequestId: 'mcp-req-write-001',
          projectPath: 'C:\\Projects\\repo',
          intent: 'implement',
          role: 'WORKER',
          executionMode: 'WORKTREE_WRITE',
          goal: 'Attempted write without owner authority',
        },
      },
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('OWNER_AUTHORITY_UNAVAILABLE');
    // Verify no job was launched or returned
    expect(res.result.content[0].text).not.toContain('"state":"PENDING"');
  });

  it('fails closed when start_job is invoked from a child worker process with lineage marker', async () => {
    const originalParent = process.env.WORKER_BRIDGE_PARENT_JOB_ID;
    const originalDepth = process.env.WORKER_BRIDGE_EXECUTION_DEPTH;
    try {
      process.env.WORKER_BRIDGE_PARENT_JOB_ID = 'job-parent-999';
      process.env.WORKER_BRIDGE_EXECUTION_DEPTH = '1';
      const res = await sendRpc({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'worker_bridge_start_job',
          arguments: {
            clientRequestId: 'nested-req',
            projectPath: 'C:\\Projects\\repo',
            intent: 'plan',
            executionMode: 'READ_ONLY',
            goal: 'Nested worker attempt',
          },
        },
      });

      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('RECURSION_BLOCKED: Nested Worker Bridge execution is blocked');
    } finally {
      if (originalParent !== undefined) {
        process.env.WORKER_BRIDGE_PARENT_JOB_ID = originalParent;
      } else {
        delete process.env.WORKER_BRIDGE_PARENT_JOB_ID;
      }
      if (originalDepth !== undefined) {
        process.env.WORKER_BRIDGE_EXECUTION_DEPTH = originalDepth;
      } else {
        delete process.env.WORKER_BRIDGE_EXECUTION_DEPTH;
      }
    }
  });

  it('handles invalid tool names with formatted error', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'invalid_tool',
        arguments: {},
      },
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Tool "invalid_tool" not found');
  });
});
