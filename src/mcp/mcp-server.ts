import * as readline from 'node:readline';
import { IpcClient } from '../service/ipc-client.js';
import { logger } from '../utils/logger.js';

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'worker_bridge_list_targets',
    description: 'List available Worker Bridge worker targets and their current availability status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'worker_bridge_start_job',
    description: 'Start a new Worker Bridge job. READ_ONLY jobs begin immediately. WORKTREE_WRITE jobs require separate owner authorization.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string', description: 'Unique idempotency key for this request.' },
        projectPath: { type: 'string', description: 'Absolute path to the repository directory under the trusted root.' },
        intent: {
          type: 'string',
          enum: ['plan', 'design', 'investigate', 'implement', 'fix', 'review', 'audit'],
          description: 'The job intent.',
        },
        executionMode: {
          type: 'string',
          enum: ['READ_ONLY', 'WORKTREE_WRITE'],
          description: 'Execution mode. READ_ONLY runs without approval; WORKTREE_WRITE requires owner approval.',
        },
        goal: { type: 'string', description: 'High-level objective or prompt for the worker.' },
        plan: { type: 'string', description: 'Optional plan text from a prior round.' },
        review: { type: 'string', description: 'Optional review instructions from Sol/Doc.' },
        workerSelection: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            platform: { type: 'string' },
            model: { type: 'string' },
            reasoning: { type: 'string' },
          },
        },
        timeoutSeconds: { type: 'number' },
        baseSha: { type: 'string' },
      },
      required: ['clientRequestId', 'projectPath', 'intent', 'executionMode', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_bridge_get_job',
    description: 'Get current status, metadata, summary, and verification details of a job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_bridge_get_result',
    description: 'Retrieve full text result of a completed job with pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID.' },
        offset: { type: 'number', description: 'Byte offset to start reading from (default 0).' },
        limit: { type: 'number', description: 'Maximum bytes to read (default 32768, max 65536).' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_bridge_cancel_job',
    description: 'Request cancellation of a running job.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID to cancel.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_bridge_prepare_project',
    description: 'Prepare a project under the trusted root by validating existing repo or cloning a remote repository.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to existing repo under trusted root.' },
        remote: { type: 'string', description: 'Git remote URL to clone (https:// or git@).' },
        destinationName: { type: 'string', description: 'Folder name under trusted root to clone into.' },
        ref: { type: 'string', description: 'Optional git branch or ref to checkout.' },
        syncMode: { type: 'string', enum: ['none', 'fetch', 'fast-forward'] },
      },
      additionalProperties: false,
    },
  },
];

export interface McpServerOptions {
  ipcClient?: IpcClient;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class McpServer {
  private readonly ipcClient: IpcClient;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private rl: readline.Interface | null = null;

  constructor(options?: McpServerOptions) {
    logger.setUseStderr(true);
    process.env.WORKER_BRIDGE_MCP = '1';
    this.ipcClient = options?.ipcClient || new IpcClient();
    this.input = options?.input || process.stdin;
    this.output = options?.output || process.stdout;
  }

  async start(): Promise<void> {
    try {
      await this.ipcClient.connect();
    } catch (err) {
      logger.warn(`Initial IPC connection failed (service may not be running yet): ${String(err)}`);
    }

    this.rl = readline.createInterface({
      input: this.input,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      if (!line.trim()) return;
      await this.handleLine(line);
    });
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    await this.ipcClient.close();
  }

  private sendResponse(response: McpJsonRpcResponse): void {
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let req: McpJsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') {
      this.sendResponse({
        jsonrpc: '2.0',
        id: (req as any)?.id || null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }

    try {
      const result = await this.dispatch(req.method, req.params);
      if (req.id !== undefined && req.id !== null) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: req.id,
          result,
        });
      }
    } catch (error) {
      if (req.id !== undefined && req.id !== null) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private async dispatch(method: string, params?: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'worker-bridge',
            version: '2.0.0',
          },
        };

      case 'notifications/initialized':
      case 'initialized':
        return {};

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: MCP_TOOL_DEFINITIONS,
        };

      case 'tools/call':
        return this.handleToolCall(params);

      default:
        throw new Error(`Method "${method}" not found.`);
    }
  }

  private async handleToolCall(params?: Record<string, unknown>): Promise<unknown> {
    const name = params?.name as string;
    const args = (params?.arguments || {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (name) {
        case 'worker_bridge_list_targets':
          result = await this.ipcClient.call('list_targets', {});
          break;

        case 'worker_bridge_start_job':
          result = await this.ipcClient.call('start_job', {
            ...args,
            excludedPlatforms: ['cursor'], // Automatically blocks recursion
          });
          break;

        case 'worker_bridge_get_job':
          result = await this.ipcClient.call('get_job', args);
          break;

        case 'worker_bridge_get_result':
          result = await this.ipcClient.call('get_result', args);
          break;

        case 'worker_bridge_cancel_job':
          result = await this.ipcClient.call('cancel_job', args);
          break;

        case 'worker_bridge_prepare_project':
          result = await this.ipcClient.call('prepare_project', args);
          break;

        default:
          throw new Error(`Tool "${name}" not found.`);
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
