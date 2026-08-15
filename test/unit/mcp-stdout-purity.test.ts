import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { McpServer } from '../../src/mcp/mcp-server.js';
import { logger } from '../../src/utils/logger.js';
import { IpcClient } from '../../src/service/ipc-client.js';

class MockIpcClient extends IpcClient {
  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}
  override async call<TResult = unknown>(): Promise<TResult> {
    return { targets: [] } as TResult;
  }
}

describe('MCP Stdout Purity', () => {
  let input: PassThrough;
  let output: PassThrough;
  let server: McpServer;

  beforeEach(async () => {
    input = new PassThrough();
    output = new PassThrough();
    server = new McpServer({
      ipcClient: new MockIpcClient(),
      input,
      output,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('guarantees stdout contains strictly valid JSON-RPC frames with 0 unparsed log bytes', async () => {
    const receivedChunks: string[] = [];
    output.on('data', (chunk) => {
      receivedChunks.push(chunk.toString('utf8'));
    });

    // Emit logs of all levels during protocol operation
    logger.debug('Debug log diagnostic');
    logger.info('Information log diagnostic');
    logger.warn('Warning log diagnostic');
    logger.error('Error log diagnostic');

    // Send a standard JSON-RPC request
    const rpcPromise = new Promise<void>((resolve) => {
      output.once('data', () => resolve());
    });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }) + '\n');
    await rpcPromise;

    // Verify all received output on stdout is valid JSON-RPC
    const fullStdout = receivedChunks.join('');
    const lines = fullStdout.split('\n').filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(100);
    }

    // Assert that none of the log messages leaked into stdout
    expect(fullStdout).not.toContain('Debug log diagnostic');
    expect(fullStdout).not.toContain('Information log diagnostic');
    expect(fullStdout).not.toContain('Warning log diagnostic');
    expect(fullStdout).not.toContain('Error log diagnostic');
  });

  it('process-level test: spawning node dist/index.js mcp-stdio outputs only valid JSON-RPC frames on stdout', async () => {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const entrypoint = path.resolve('dist/index.js');

    const child = spawn(process.execPath, [entrypoint, 'mcp-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));

    // Send initialize request
    const initReq = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n';
    child.stdin.write(initReq);

    // Send tools/list request
    const toolsReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n';
    child.stdin.write(toolsReq);

    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 800));

    child.kill();

    const fullStdout = stdoutChunks.join('');
    const stdoutLines = fullStdout.split('\n').filter((l) => l.trim().length > 0);

    expect(stdoutLines.length).toBeGreaterThanOrEqual(2);

    for (const line of stdoutLines) {
      // Must parse cleanly as JSON
      const parsed = JSON.parse(line.trim());
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBeTypeOf('number');
      expect(parsed.result).toBeDefined();
    }
  });
});
