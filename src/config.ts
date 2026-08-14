import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BridgeConfig, ProjectConfig } from './types.js';

export const DEFAULT_CONFIG_FILENAME = 'config.json';
export const USER_BRIDGE_DIR = path.join(os.homedir(), '.gemini-worker-bridge');

export function getDefaultConfigPath(): string {
  const localPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  const userPath = path.join(USER_BRIDGE_DIR, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(userPath)) {
    return userPath;
  }
  return localPath;
}

export function validateConfig(raw: Partial<BridgeConfig>): BridgeConfig {
  if (!raw.mailboxRepoPath || typeof raw.mailboxRepoPath !== 'string') {
    throw new Error('Config validation failed: "mailboxRepoPath" must be a valid path string.');
  }

  if (!raw.workerRootDir || typeof raw.workerRootDir !== 'string') {
    throw new Error('Config validation failed: "workerRootDir" must be a valid path string.');
  }

  if (!raw.agyExecutable || typeof raw.agyExecutable !== 'string') {
    throw new Error('Config validation failed: "agyExecutable" must be a valid executable path string.');
  }

  if (!raw.workerModel || typeof raw.workerModel !== 'string') {
    throw new Error('Config validation failed: "workerModel" must be specified (e.g. "flash").');
  }

  if (!raw.allowedProjects || typeof raw.allowedProjects !== 'object') {
    throw new Error('Config validation failed: "allowedProjects" must be an object map.');
  }

  // Validate allowed projects
  for (const [key, proj] of Object.entries(raw.allowedProjects)) {
    if (!proj || typeof proj.path !== 'string') {
      throw new Error(`Config validation failed: Project "${key}" has invalid path.`);
    }
  }

  return {
    mailboxRepoPath: path.resolve(raw.mailboxRepoPath),
    mailboxRemote: raw.mailboxRemote || 'origin',
    pollIntervalSeconds: typeof raw.pollIntervalSeconds === 'number' && raw.pollIntervalSeconds > 0 ? raw.pollIntervalSeconds : 20,
    workerRootDir: path.resolve(raw.workerRootDir),
    agyExecutable: raw.agyExecutable,
    workerModel: raw.workerModel,
    pushWorkerBranches: raw.pushWorkerBranches ?? true,
    notificationsEnabled: raw.notificationsEnabled ?? true,
    allowedProjects: raw.allowedProjects as Record<string, ProjectConfig>,
  };
}

export function loadConfig(configPath?: string): BridgeConfig {
  const resolvedPath = configPath ? path.resolve(configPath) : getDefaultConfigPath();
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at: ${resolvedPath}. Please copy config.example.json to config.json.`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse JSON in configuration file (${resolvedPath}): ${String(err)}`);
  }

  return validateConfig(parsed as Partial<BridgeConfig>);
}

export class ConfigManager {
  private config: BridgeConfig;

  constructor(configOrPath?: BridgeConfig | string) {
    if (typeof configOrPath === 'string') {
      this.config = loadConfig(configOrPath);
    } else if (configOrPath && typeof configOrPath === 'object') {
      this.config = validateConfig(configOrPath);
    } else {
      this.config = loadConfig();
    }
  }

  getConfig(): BridgeConfig {
    return this.config;
  }

  isProjectAllowed(projectId: string): boolean {
    const proj = this.config.allowedProjects[projectId];
    return !!proj && proj.allowed === true;
  }

  getProjectConfig(projectId: string): ProjectConfig | null {
    if (!this.isProjectAllowed(projectId)) return null;
    return this.config.allowedProjects[projectId];
  }

  validateJobProjectId(projectId: string): { ok: boolean; reason?: string } {
    if (!projectId || typeof projectId !== 'string') {
      return { ok: false, reason: 'Missing or non-string projectId' };
    }
    if (!this.config.allowedProjects[projectId]) {
      return { ok: false, reason: `Unknown project ID: "${projectId}". Not in local allowlist.` };
    }
    if (this.config.allowedProjects[projectId].allowed !== true) {
      return { ok: false, reason: `Project "${projectId}" is marked allowed=false in local config.` };
    }
    return { ok: true };
  }
}
