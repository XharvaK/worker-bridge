import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from '../config.js';
import { Ledger } from '../engine/ledger.js';
import { ModelSelector } from '../engine/model-selector.js';
import { ProcessManager } from '../engine/process-manager.js';
import { TargetAvailabilityLedger } from '../engine/target-availability-ledger.js';
import { WorktreeManager } from '../git/worktree.js';
import { AdapterRegistry } from '../worker/adapter-registry.js';
import { AntigravityAdapter } from '../worker/agy-adapter.js';
import { CodexAdapter } from '../worker/codex-adapter.js';
import { CursorAdapter } from '../worker/cursor-adapter.js';
import { OpenCodeAdapter } from '../worker/opencode-adapter.js';
import { logger } from '../utils/logger.js';
import { assertPathContained, canonicalizePath } from '../utils/path-authority.js';
import {
  ApproveJobParams,
  ApproveJobResult,
  CancelJobParams,
  CancelJobResult,
  GetJobParams,
  GetJobResult,
  GetResultParams,
  GetResultResult,
  IpcMethod,
  ListTargetsResult,
  PrepareProjectParams,
  PrepareProjectResult,
  StartJobParams,
  StartJobResult,
} from './ipc-protocol.js';
import { IpcServer } from './ipc-server.js';
import { JobManager } from './job-manager.js';

const execFileAsync = promisify(execFile);

export interface DurableServiceOptions {
  pipePath?: string;
  configManager?: ConfigManager;
  ledger?: Ledger;
  availabilityLedger?: TargetAvailabilityLedger;
  jobManager?: JobManager;
  trustedRoots?: string[];
}

export class DurableService {
  private readonly configManager: ConfigManager;
  private readonly ledger: Ledger;
  private readonly availability: TargetAvailabilityLedger;
  private readonly registry: AdapterRegistry;
  private readonly modelSelector: ModelSelector;
  private readonly processManager: ProcessManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly jobManager: JobManager;
  private readonly ipcServer: IpcServer;
  private readonly trustedRoots: string[];

  constructor(options?: DurableServiceOptions) {
    this.configManager = options?.configManager || new ConfigManager();
    const cfg = this.configManager.getConfig();

    this.ledger = options?.ledger || new Ledger();
    this.availability = options?.availabilityLedger || new TargetAvailabilityLedger();
    this.processManager = new ProcessManager();
    this.worktreeManager = new WorktreeManager(cfg.workerRootDir);

    this.registry = new AdapterRegistry();
    const agyExe = cfg.platforms?.antigravity?.executable || cfg.agyExecutable;
    const agyModel = cfg.platforms?.antigravity?.defaultModel || cfg.workerModel;
    const opencodeExe = cfg.platforms?.opencode?.executable || 'opencode';
    const opencodeModel = cfg.platforms?.opencode?.defaultModel || 'opencode/deepseek-v4-flash-free';
    const codexExe = cfg.platforms?.codex?.executable || 'codex';
    const cursorExe = cfg.platforms?.['cursor-cli']?.executable || cfg.platforms?.cursor?.executable || 'cursor';
    const cursorModel = cfg.platforms?.['cursor-cli']?.defaultModel || cfg.platforms?.cursor?.defaultModel || 'grok-4.6';

    this.registry.register(new AntigravityAdapter(agyExe, agyModel, this.processManager));
    this.registry.register(new OpenCodeAdapter(opencodeExe, opencodeModel, this.processManager));
    this.registry.register(new CodexAdapter(codexExe, this.processManager));
    this.registry.register(new CursorAdapter(cursorExe, cursorModel, this.processManager));

    this.modelSelector = new ModelSelector(this.registry, cfg, this.availability);
    this.trustedRoots = options?.trustedRoots || [
      process.env.WORKER_BRIDGE_TRUSTED_ROOT || path.resolve(process.env.USERPROFILE || 'C:\\Users\\Xharv', 'Projects'),
    ];

    this.jobManager = options?.jobManager || new JobManager({ trustedRoots: this.trustedRoots });

    this.ipcServer = new IpcServer({
      pipePath: options?.pipePath,
      onRequest: (method, params, connectionId) => this.handleRequest(method, params, connectionId),
    });
  }

  async start(): Promise<void> {
    await this.ipcServer.start();
    logger.info('Durable Worker Bridge service started successfully.');
  }

  async stop(): Promise<void> {
    await this.ipcServer.close();
    logger.info('Durable Worker Bridge service stopped.');
  }

  getPipePath(): string {
    return this.ipcServer.getPipePath();
  }

  private async handleRequest(
    method: IpcMethod,
    params: Record<string, unknown>,
    connectionId: string
  ): Promise<unknown> {
    switch (method) {
      case 'list_targets':
        return this.listTargets();

      case 'start_job':
        return this.startJob(params as unknown as StartJobParams);

      case 'get_job':
        return this.getJob(params as unknown as GetJobParams);

      case 'get_result':
        return this.getResult(params as unknown as GetResultParams);

      case 'cancel_job':
        return this.cancelJob(params as unknown as CancelJobParams);

      case 'prepare_project':
        return this.prepareProject(params as unknown as PrepareProjectParams);

      case 'approve_job':
        return this.approveJob(params as unknown as ApproveJobParams, connectionId);

      case 'shutdown':
        setTimeout(() => this.stop(), 50);
        return { shuttingDown: true };

      default:
        throw new Error(`UNKNOWN_METHOD: Method "${method}" is not supported.`);
    }
  }

  private async listTargets(): Promise<ListTargetsResult> {
    const policy = this.modelSelector.getPolicy();
    const targets = Object.values(policy.targets || {}).slice(0, 128);

    const mapped = targets.map((t) => ({
      targetId: t.targetId,
      platformId: t.platformId,
      displayName: t.displayName,
      explicitOnly: t.explicitOnly,
      modelBinding: t.modelBinding,
      available: this.availability.isEligible(t.targetId),
      reasoningStrategy: t.reasoning?.strategy,
    }));

    return { targets: mapped };
  }

  private startJob(params: StartJobParams): StartJobResult {
    return this.jobManager.createJob(params);
  }

  private getJob(params: GetJobParams): GetJobResult {
    return this.jobManager.getJob(params.jobId);
  }

  private getResult(params: GetResultParams): GetResultResult {
    return this.jobManager.getResult(params.jobId, params.offset, params.limit);
  }

  private cancelJob(params: CancelJobParams): CancelJobResult {
    return this.jobManager.cancelJob(params.jobId);
  }

  private approveJob(params: ApproveJobParams, connectionId: string): ApproveJobResult {
    return this.jobManager.approveJob(params.challenge, `ipc_${connectionId}`);
  }

  private async prepareProject(params: PrepareProjectParams): Promise<PrepareProjectResult> {
    const trustedRoot = this.trustedRoots[0];

    // Case 1: Existing project validation
    if (params.projectPath) {
      const canonical = canonicalizePath(params.projectPath);
      assertPathContained(canonical, this.trustedRoots);

      if (!fs.existsSync(canonical)) {
        throw new Error(`PROJECT_NOT_FOUND: Directory "${canonical}" does not exist.`);
      }

      const gitDir = path.join(canonical, '.git');
      if (!fs.existsSync(gitDir)) {
        throw new Error(`NOT_A_GIT_REPO: Directory "${canonical}" does not contain a git repository.`);
      }

      if (params.syncMode === 'fetch') {
        try {
          await execFileAsync('git', ['-C', canonical, 'fetch', 'origin', '--'], { windowsHide: true });
        } catch (err) {
          logger.warn(`Failed to fetch origin in ${canonical}: ${String(err)}`);
        }
      } else if (params.syncMode === 'fast-forward') {
        const status = await execFileAsync('git', ['-C', canonical, 'status', '--porcelain'], { windowsHide: true });
        if (status.stdout.trim()) {
          throw new Error(`DIRTY_WORKTREE: Cannot fast-forward repository with uncommitted changes in "${canonical}".`);
        }
        try {
          await execFileAsync('git', ['-C', canonical, 'merge', '--ff-only', '@{u}'], { windowsHide: true });
        } catch {
          throw new Error(`SYNC_NOT_FAST_FORWARD: Cannot fast-forward branch in "${canonical}".`);
        }
      }

      const rev = await execFileAsync('git', ['-C', canonical, 'rev-parse', 'HEAD'], { windowsHide: true });
      const branchRes = await execFileAsync('git', ['-C', canonical, 'branch', '--show-current'], { windowsHide: true });
      const statusRes = await execFileAsync('git', ['-C', canonical, 'status', '--porcelain'], { windowsHide: true });

      return {
        projectPath: canonical,
        status: params.syncMode && params.syncMode !== 'none' ? 'synced' : 'ready',
        baseSha: rev.stdout.trim(),
        branch: branchRes.stdout.trim(),
        clean: statusRes.stdout.trim().length === 0,
      };
    }

    // Case 2: Clone new project under trusted root
    if (params.remote && params.destinationName) {
      if (
        params.destinationName.startsWith('-') ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(params.destinationName)
      ) {
        throw new Error(`INVALID_DESTINATION: Destination name "${params.destinationName}" is invalid or starts with hyphen.`);
      }

      const dest = path.join(trustedRoot, params.destinationName);
      if (fs.existsSync(dest)) {
        throw new Error(`DESTINATION_COLLISION: Directory "${dest}" already exists.`);
      }

      if (
        (!params.remote.startsWith('https://') && !params.remote.startsWith('git@')) ||
        params.remote.startsWith('-') ||
        params.remote.includes('\n') ||
        params.remote.includes('\r')
      ) {
        throw new Error(`INVALID_REMOTE: Remote "${params.remote}" must use https:// or git@ protocol without leading hyphens.`);
      }

      if (params.ref) {
        if (
          params.ref.startsWith('-') ||
          !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,127}$/.test(params.ref)
        ) {
          throw new Error(`INVALID_REF: Git ref "${params.ref}" is invalid or starts with hyphen.`);
        }
      }

      await execFileAsync('git', ['clone', '--single-branch', '--', params.remote, dest], { windowsHide: true });

      if (params.ref) {
        await execFileAsync('git', ['-C', dest, 'checkout', params.ref, '--'], { windowsHide: true });
      }

      const rev = await execFileAsync('git', ['-C', dest, 'rev-parse', 'HEAD'], { windowsHide: true });
      const branchRes = await execFileAsync('git', ['-C', dest, 'branch', '--show-current'], { windowsHide: true });

      return {
        projectPath: dest,
        status: 'cloned',
        baseSha: rev.stdout.trim(),
        branch: branchRes.stdout.trim(),
        clean: true,
      };
    }

    throw new Error('INVALID_PARAMS: Either projectPath or (remote and destinationName) must be provided.');
  }
}
