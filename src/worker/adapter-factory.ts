import { BridgeConfig } from '../types.js';
import { ProcessManager } from '../engine/process-manager.js';
import { AdapterRegistry } from './adapter-registry.js';
import { AntigravityAdapter } from './agy-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { FreebuffAdapter } from './freebuff-adapter.js';

/**
 * Single construction site for the standard adapter registry. Every execution
 * authority (mailbox orchestrator, durable IPC service, shared kernel defaults)
 * builds its adapters here so platform wiring and process identity stay
 * coherent.
 */
export function buildAdapterRegistry(cfg: BridgeConfig, processManager: ProcessManager): AdapterRegistry {
  const registry = new AdapterRegistry();
  const agyExe = cfg.platforms?.antigravity?.executable || cfg.agyExecutable;
  const agyModel = cfg.platforms?.antigravity?.defaultModel || cfg.workerModel;
  const opencodeExe = cfg.platforms?.opencode?.executable || 'opencode';
  const opencodeModel = cfg.platforms?.opencode?.defaultModel || 'opencode/deepseek-v4-flash-free';
  const codexExe = cfg.platforms?.codex?.executable || 'codex';
  const cursorExe = cfg.platforms?.['cursor-cli']?.executable || cfg.platforms?.cursor?.executable || 'cursor';
  const cursorModel = cfg.platforms?.['cursor-cli']?.defaultModel || cfg.platforms?.cursor?.defaultModel || 'grok-4.6';
  const freebuffExe = cfg.platforms?.freebuff?.executable || 'freebuff';

  registry.register(new AntigravityAdapter(agyExe, agyModel, processManager));
  registry.register(new OpenCodeAdapter(opencodeExe, opencodeModel, processManager));
  registry.register(new CodexAdapter(codexExe, processManager));
  registry.register(new CursorAdapter(cursorExe, cursorModel, processManager));
  registry.register(new FreebuffAdapter(freebuffExe, processManager));
  return registry;
}