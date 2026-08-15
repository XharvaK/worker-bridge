import { describe, it, expect } from 'vitest';
import {
  getServicePipePath,
  serializeIpcMessage,
  parseIpcMessage,
  MAX_IPC_MESSAGE_BYTES,
  IpcRequest,
  IpcResponse,
} from '../../src/service/ipc-protocol.js';

describe('IPC Protocol framing and serialization', () => {
  it('generates valid OS-specific pipe/socket paths', () => {
    const pipePath = getServicePipePath();
    if (process.platform === 'win32') {
      expect(pipePath).toMatch(/^\\\\\.\\pipe\\worker-bridge-/);
    } else {
      expect(pipePath).toContain('worker-bridge-');
    }
  });

  it('serializes and parses requests and responses correctly', () => {
    const req: IpcRequest = {
      requestId: 'req-001',
      method: 'list_targets',
      params: {},
    };
    const serialized = serializeIpcMessage(req);
    expect(serialized.endsWith('\n')).toBe(true);

    const parsed = parseIpcMessage<IpcRequest>(serialized);
    expect(parsed.requestId).toBe('req-001');
    expect(parsed.method).toBe('list_targets');
    expect(parsed.params).toEqual({});
  });

  it('serializes and parses error responses correctly', () => {
    const res: IpcResponse = {
      requestId: 'req-002',
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The durable service is not running.',
      },
    };
    const serialized = serializeIpcMessage(res);
    const parsed = parseIpcMessage<IpcResponse>(serialized);
    expect(parsed.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(parsed.error?.message).toBe('The durable service is not running.');
  });

  it('rejects oversized IPC messages exceeding MAX_IPC_MESSAGE_BYTES', () => {
    const oversizedPayload = 'a'.repeat(MAX_IPC_MESSAGE_BYTES + 10);
    const oversizedMsg: IpcRequest = {
      requestId: 'req-oversized',
      method: 'start_job',
      params: { big: oversizedPayload },
    };

    expect(() => serializeIpcMessage(oversizedMsg)).toThrow('MESSAGE_TOO_LARGE');
    expect(() => parseIpcMessage(JSON.stringify(oversizedMsg))).toThrow('MESSAGE_TOO_LARGE');
  });

  it('rejects empty or invalid JSON messages', () => {
    expect(() => parseIpcMessage('')).toThrow('INVALID_IPC_MESSAGE');
    expect(() => parseIpcMessage('   ')).toThrow('INVALID_IPC_MESSAGE');
    expect(() => parseIpcMessage('invalid json {')).toThrow('INVALID_IPC_MESSAGE');
  });
});
