import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import defaultSelectionPolicy from './policy/default-selection-policy.json' with { type: 'json' };
import {
  BridgeConfig,
  ProjectConfig,
  PlatformConfig,
  ModelAliasConfig,
  SelectionPolicyConfig,
  WorkerTargetConfig,
} from './types.js';

export const DEFAULT_CONFIG_FILENAME = 'config.json';
export const USER_BRIDGE_DIR_PRIMARY = path.join(os.homedir(), '.worker-bridge');
export const USER_BRIDGE_DIR_LEGACY = path.join(os.homedir(), '.gemini-worker-bridge');

export const USER_BRIDGE_DIR = fs.existsSync(USER_BRIDGE_DIR_PRIMARY)
  ? USER_BRIDGE_DIR_PRIMARY
  : fs.existsSync(USER_BRIDGE_DIR_LEGACY)
  ? USER_BRIDGE_DIR_LEGACY
  : USER_BRIDGE_DIR_PRIMARY;

export function getDefaultConfigPath(): string {
  const localPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  const userPrimary = path.join(USER_BRIDGE_DIR_PRIMARY, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(userPrimary)) {
    return userPrimary;
  }
  const userLegacy = path.join(USER_BRIDGE_DIR_LEGACY, DEFAULT_CONFIG_FILENAME);
  if (fs.existsSync(userLegacy)) {
    return userLegacy;
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

  if (raw.agyExecutable !== undefined && (typeof raw.agyExecutable !== 'string' || !raw.agyExecutable)) {
    throw new Error('Config validation failed: "agyExecutable" must be a valid executable path string.');
  }

  if (raw.workerModel !== undefined && (typeof raw.workerModel !== 'string' || !raw.workerModel)) {
    throw new Error('Config validation failed: "workerModel" must be specified (e.g. "gemini-3.7-flash-high").');
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

  // Set default platforms if not provided.
  const platforms: Record<string, PlatformConfig> = { ...(raw.platforms || {}) };
  if (!platforms.antigravity) {
    platforms.antigravity = {
      enabled: true,
      executable: raw.agyExecutable || 'C:\\Users\\Xharv\\AppData\\Local\\agy\\bin\\agy.exe',
      defaultModel: raw.workerModel || 'gemini-3.7-flash-high',
    };
  }
  if (!platforms.opencode) {
    platforms.opencode = {
      enabled: true,
      executable: 'opencode',
      defaultModel: 'opencode/deepseek-v4-flash-free',
    };
  }
  if (!platforms.codex) {
    platforms.codex = {
      enabled: true,
      executable: 'codex',
    };
  }
  if (!platforms['cursor-cli'] && !platforms.cursor) {
    platforms['cursor-cli'] = {
      enabled: true,
      executable: 'cursor',
      defaultModel: 'grok-4.6',
    };
  }

  const selectionPolicy = normalizeSelectionPolicy(raw.selectionPolicy);

  return {
    mailboxRepoPath: path.resolve(raw.mailboxRepoPath),
    mailboxRemote: raw.mailboxRemote || 'origin',
    pollIntervalSeconds: typeof raw.pollIntervalSeconds === 'number' && raw.pollIntervalSeconds > 0 ? raw.pollIntervalSeconds : 20,
    workerRootDir: path.resolve(raw.workerRootDir),
    platforms,
    modelAliases: raw.modelAliases as Record<string, ModelAliasConfig> | undefined,
    selectionPolicy,
    pushWorkerBranches: raw.pushWorkerBranches ?? true,
    notificationsEnabled: raw.notificationsEnabled ?? true,
    allowedProjects: raw.allowedProjects as Record<string, ProjectConfig>,
    agyExecutable: raw.agyExecutable || platforms.antigravity.executable,
    workerModel: raw.workerModel || platforms.antigravity.defaultModel,
  };
}

function normalizeSelectionPolicy(rawPolicy?: SelectionPolicyConfig): SelectionPolicyConfig {
  const defaults = defaultSelectionPolicy as SelectionPolicyConfig;
  const rawTargets = rawPolicy?.targets || {};
  const targets: Record<string, WorkerTargetConfig> = {};

  for (const [key, candidate] of Object.entries({ ...defaults.targets, ...rawTargets })) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Config validation failed: selection target "${key}" must be an object.`);
    }

    const target = candidate as WorkerTargetConfig;
    if (!target.platformId || !target.displayName || !target.reasoning?.strategy) {
      throw new Error(`Config validation failed: selection target "${key}" is incomplete.`);
    }
    if (target.modelBinding !== undefined && !['FIXED', 'EXPLICIT_DISCOVERED'].includes(target.modelBinding)) {
      throw new Error(`Config validation failed: selection target "${key}" has invalid modelBinding.`);
    }
    const modelBinding = target.modelBinding ?? 'FIXED';
    if (modelBinding === 'FIXED' && (!target.modelId || typeof target.modelId !== 'string')) {
      throw new Error(`Config validation failed: selection target "${key}" requires modelId for FIXED binding.`);
    }
    if (target.modelId !== undefined && (typeof target.modelId !== 'string' || !target.modelId)) {
      throw new Error(`Config validation failed: selection target "${key}" has invalid modelId.`);
    }

    const normalizedModelId = target.modelId === undefined ? undefined : normalizeLegacyGeminiReference(target.modelId);
    const normalizedDisplayName = normalizeLegacyGeminiReference(target.displayName);
    targets[key] = {
      ...target,
      targetId: target.targetId || key,
      modelId: target.modelId === undefined ? undefined : normalizedModelId,
      modelBinding,
      displayName: normalizedDisplayName,
      aliases: target.aliases ? [...target.aliases] : [],
    };
  }

  return {
    targets,
    roleRankings: {
      ...defaults.roleRankings,
      ...(rawPolicy?.roleRankings || {}),
    },
    allowFallbackByDefault: rawPolicy?.allowFallbackByDefault ?? defaults.allowFallbackByDefault,
    maxFallbackAttempts: rawPolicy?.maxFallbackAttempts ?? defaults.maxFallbackAttempts,
    reviewerPreferDifferentTarget:
      rawPolicy?.reviewerPreferDifferentTarget ?? defaults.reviewerPreferDifferentTarget,
  };
}

export function normalizeLegacyGeminiReference(value: string): string {
  const legacyVersion = ['3', '5'].join('.');
  const modelPattern = new RegExp(`gemini-${legacyVersion.replace('.', '\\.')}-flash-high`, 'gi');
  const displayPattern = new RegExp(`gemini\\s+flash\\s+${legacyVersion.replace('.', '\\.')}`, 'gi');
  return value
    .replace(modelPattern, 'gemini-3.7-flash-high')
    .replace(displayPattern, 'Gemini Flash 3.7');
}

export function getDefaultSelectionPolicy(): SelectionPolicyConfig {
  return normalizeSelectionPolicy();
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
