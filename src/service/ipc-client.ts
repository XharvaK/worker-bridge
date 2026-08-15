import * as net from 'node:net';
import * as crypto from 'node:crypto';
import {
  getServicePipePath,
  IpcMethod,
  IpcRequest,
  IpcResponse,
  parseIpcMessage,
  serializeIpcMessage,
} from './ipc-protocol.js';

export interface IpcClientOptions {
  pipePath?: string;
  timeoutMs?: number;
}

export class IpcClient {
  private readonly pipePath: string;
  private readonly timeoutMs: number;
  private socket: net.Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options?: IpcClientOptions) {
    this.pipePath = options?.pipePath || getServicePipePath();
    this.timeoutMs = options?.timeoutMs || 30_000;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath, () => {
        this.socket = socket;
        this.buffer = '';
        resolve();
      });

      socket.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = parseIpcMessage<IpcResponse>(line);
            const pending = this.pendingRequests.get(response.requestId);
            if (pending) {
              this.pendingRequests.delete(response.requestId);
              clearTimeout(pending.timer);
              if (response.error) {
                const err = new Error(response.error.message);
                (err as any).code = response.error.code;
                pending.reject(err);
              } else {
                pending.resolve(response.result);
              }
            }
          } catch (err) {
            // Unparseable frame
          }
        }
      });

      socket.on('error', (err) => {
        if (!this.socket) {
          reject(err);
        } else {
          this.rejectAllPending(err);
        }
      });

      socket.on('close', () => {
        this.socket = null;
        this.rejectAllPending(new Error('IPC_CONNECTION_CLOSED: Pipe connection was closed.'));
      });
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  async call<TResult = unknown, TParams = Record<string, unknown>>(
    method: IpcMethod,
    params: TParams = {} as TParams
  ): Promise<TResult> {
    if (!this.socket || this.socket.destroyed) {
      await this.connect();
    }

    const requestId = crypto.randomUUID();
    const request: IpcRequest<TParams> = {
      requestId,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`IPC_TIMEOUT: Method "${method}" timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      try {
        this.socket!.write(serializeIpcMessage(request as unknown as IpcRequest));
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.rejectAllPending(new Error('IPC_CLIENT_CLOSED: Client was closed.'));
    if (this.socket) {
      return new Promise((resolve) => {
        this.socket!.end(() => {
          this.socket = null;
          resolve();
        });
      });
    }
  }

  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }
}
