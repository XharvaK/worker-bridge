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

  it('dispatches worker_bridge_start_job with excludedPlatforms: [cursor]', async () => {
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
        },
      },
    });

    expect(mockClient.calls[0].method).toBe('start_job');
    expect((mockClient.calls[0].params as any).excludedPlatforms).toEqual(['cursor']);
    expect(res.result.content[0].text).toContain('job-123');
  });

  it('handles invalid tool names with formatted error', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 5,
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
