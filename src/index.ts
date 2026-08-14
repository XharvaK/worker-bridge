#!/usr/bin/env node
import { ConfigManager } from './config.js';
import { Orchestrator } from './engine/orchestrator.js';
import { Ledger } from './engine/ledger.js';
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

  const orchestrator = new Orchestrator(configManager);

  if (command === 'start') {
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
    logger.info('Running single polling tick...');
    await orchestrator.init();
    await orchestrator.tick();
    logger.info('Tick finished.');
    process.exit(0);
  } else if (command === 'status') {
    const ledger = new Ledger();
    console.log('\n=== Worker Bridge Status ===');
    console.log(`Config Mailbox: ${configManager.getConfig().mailboxRepoPath}`);
    console.log(`Platforms:      ${orchestrator.getAdapterRegistry().listPlatforms().join(', ')}`);
    console.log(`Allowed Projects: ${Object.keys(configManager.getConfig().allowedProjects).join(', ')}`);
    console.log('\n--- Ledger Jobs ---');
    console.dir(ledger, { depth: null });
    process.exit(0);
  } else if (command === 'cancel') {
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

Codex is explicit-only: select policy alias codex_explicit with an exact discovered model. It is never selected automatically.

Commands:
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
