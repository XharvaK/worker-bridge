#!/usr/bin/env node
import { ConfigManager } from './config.js';
import { logger } from './utils/logger.js';

function parseCliArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  let configPath: string | undefined;
  let targetJobId: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else if (arg === '-c' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (!arg.startsWith('-') && !targetJobId) {
      targetJobId = arg;
    }
  }

  return { command, configPath, targetJobId };
}

async function main() {
  const { command, configPath, targetJobId } = parseCliArgs();

  let configManager: ConfigManager;
  try {
    configManager = new ConfigManager(configPath);
  } catch (err: any) {
    console.error(`Configuration Error: ${err.message}`);
    process.exit(1);
  }

  if (command === 'serve') {
    const { DurableService } = await import('./service/durable-service.js');
    const service = new DurableService({ configManager });
    logger.info(`Starting durable Worker Bridge service on: ${service.getPipePath()}`);

    const shutdown = async () => {
      logger.info('Received shutdown signal. Stopping durable service...');
      await service.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await service.start();
  } else if (command === 'mcp-stdio') {
    const { McpServer } = await import('./mcp/mcp-server.js');
    const mcp = new McpServer();
    await mcp.start();
  } else if (command === 'approve') {
    const challenge = targetJobId;
    if (!challenge) {
      console.error('Usage: worker-bridge approve <challenge-uuid>');
      process.exit(1);
    }
    const { IpcClient } = await import('./service/ipc-client.js');
    const client = new IpcClient();
    try {
      await client.connect();
      const result = await client.call<any>('approve_job', { challenge });
      console.log(`Job ${result.jobId} approved successfully. Current state: ${result.state}`);
      await client.close();
      process.exit(0);
    } catch (err: any) {
      console.error(`Approval failed: ${err.message}`);
      await client.close();
      process.exit(1);
    }
  } else if (command === 'start') {
    const { Orchestrator } = await import('./engine/orchestrator.js');
    const orchestrator = new Orchestrator(configManager);
    logger.info('Starting Worker Bridge daemon (Antigravity, OpenCode, and explicit-only Codex)...');

    const shutdown = () => {
      logger.info('Received shutdown signal. Stopping gracefully...');
      orchestrator.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await orchestrator.startLoop();
  } else if (command === 'run-once') {
    const { Orchestrator } = await import('./engine/orchestrator.js');
    const orchestrator = new Orchestrator(configManager);
    logger.info('Running single polling tick...');
    await orchestrator.init();
    await orchestrator.tick();
    logger.info('Tick finished.');
    process.exit(0);
  } else if (command === 'status') {
    const { Ledger } = await import('./engine/ledger.js');
    const { buildAdapterRegistry } = await import('./worker/adapter-factory.js');
    const { ProcessManager } = await import('./engine/process-manager.js');
    const ledger = new Ledger();
    const registry = buildAdapterRegistry(configManager.getConfig(), new ProcessManager());
    console.log('\n=== Worker Bridge Status ===');
    console.log(`Config Mailbox: ${configManager.getConfig().mailboxRepoPath}`);
    console.log(`Platforms:      ${registry.listPlatforms().join(', ')}`);
    console.log(`Allowed Projects: ${Object.keys(configManager.getConfig().allowedProjects).join(', ')}`);
    console.log('\n--- Ledger Jobs ---');
    console.dir(ledger, { depth: null });
    process.exit(0);
  } else if (command === 'cancel') {
    const { Ledger } = await import('./engine/ledger.js');
    if (!targetJobId) {
      console.error('Usage: worker-bridge cancel <jobId>');
      process.exit(1);
    }
    logger.info(`Cancelling job: ${targetJobId}`);
    const ledger = new Ledger();
    ledger.recordFinish(targetJobId, 'CANCELLED');
    logger.info(`Job ${targetJobId} marked CANCELLED in ledger.`);
    process.exit(0);
  } else {
    console.log(`
Worker Bridge - Platform-Agnostic Headless AI Worker Daemon
Supported Platforms: Antigravity (AGY), OpenCode, Codex CLI (explicit-only target)

Commands:
  serve [--config=<path>]       Start the durable Worker Bridge background service (Named Pipe + IPC)
  mcp-stdio                     Run the MCP JSON-RPC 2.0 stdio adapter for Cursor Agent
  approve <challenge>           Approve a pending WORKTREE_WRITE job challenge via IPC
  start [--config=<path>]       Start the continuous mailbox polling daemon
  run-once [--config=<path>]    Run a single polling tick and exit
  status [--config=<path>]      Print current ledger and configuration status
  cancel <jobId>                Mark a job cancelled in the local ledger
`);
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error(`Fatal Bridge Error: ${err.message || String(err)}`);
  process.exit(1);
});
