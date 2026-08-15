import * as net from 'node:net';
import * as fs from 'node:fs';
import { logger } from '../utils/logger.js';
import {
  getServicePipePath,
  IpcMethod,
  IpcRequest,
  IpcResponse,
  parseIpcMessage,
  serializeIpcMessage,
} from './ipc-protocol.js';

export type IpcRequestHandler = (
  method: IpcMethod,
  params: Record<string, unknown>,
  connectionId: string
) => Promise<unknown>;

export interface IpcServerOptions {
  pipePath?: string;
  onRequest: IpcRequestHandler;
}

/**
 * Local IPC Server using Windows Named Pipes (\\.\pipe\worker-bridge-<username>) or Unix Domain Sockets.
 *
 * Windows Security Model Note:
 * Node/libuv creates named pipes with default OS security attributes (NULL security descriptor).
 * This grants Full Control to Creator Owner, Administrators, and LocalSystem, with default OS read access.
 * Worker Bridge does NOT install a custom per-logon-SID DACL. Therefore, any process in the same user
 * session (e.g. Cursor Agent) or local administrative processes can connect to the pipe.
 * In accordance with the Worker Bridge authority model, pipe connection DOES NOT constitute human owner
 * authority. Consequently, WORKTREE_WRITE execution mode is strictly failed closed in MCP v1.
 */
export class IpcServer {
  private readonly pipePath: string;
  private readonly onRequest: IpcRequestHandler;
  private server: net.Server | null = null;
  private connectionCounter = 0;
  private activeSockets = new Set<net.Socket>();

  constructor(options: IpcServerOptions) {
    this.pipePath = options.pipePath || getServicePipePath();
    this.onRequest = options.onRequest;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('IPC_SERVER_ALREADY_RUNNING: Server is already started.');
    }

    // Clean up stale socket file on non-Windows platforms
    if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
      try {
        fs.unlinkSync(this.pipePath);
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));

      server.on('error', (err: NodeJS.ErrnoException) => {
        logger.error(`IPC server error: ${err.message}`);
        if (!this.server) {
          reject(err);
        }
      });

      server.listen(this.pipePath, () => {
        this.server = server;
        logger.info(`IPC server listening on: ${this.pipePath}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.connectionCounter += 1;
    const connectionId = `conn-${this.connectionCounter}`;
    this.activeSockets.add(socket);

    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete trailing fragment

      for (const line of lines) {
        if (!line.trim()) continue;
        await this.processMessage(line, socket, connectionId);
      }
    });

    socket.on('error', (err) => {
      logger.warn(`IPC socket [${connectionId}] error: ${err.message}`);
    });

    socket.on('close', () => {
      this.activeSockets.delete(socket);
    });
  }

  private async processMessage(
    raw: string,
    socket: net.Socket,
    connectionId: string
  ): Promise<void> {
    let request: IpcRequest | null = null;
    try {
      request = parseIpcMessage<IpcRequest>(raw);
      const result = await this.onRequest(request.method, request.params || {}, connectionId);
      const response: IpcResponse = {
        requestId: request.requestId,
        result,
      };
      socket.write(serializeIpcMessage(response));
    } catch (error) {
      const response: IpcResponse = {
        requestId: request?.requestId || 'unknown',
        error: {
          code: error instanceof Error && 'code' in error ? String((error as any).code) : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      try {
        socket.write(serializeIpcMessage(response));
      } catch {
        // Socket may have closed
      }
    }
  }

  async close(): Promise<void> {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
            try {
              fs.unlinkSync(this.pipePath);
            } catch {
              // ignore
            }
          }
          resolve();
        });
      });
    }
  }

  getPipePath(): string {
    return this.pipePath;
  }
}
