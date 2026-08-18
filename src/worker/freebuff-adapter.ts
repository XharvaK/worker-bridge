import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { USER_BRIDGE_DIR } from '../config.js';
import { getSafeProcessInvocation, ProcessManager } from '../engine/process-manager.js';
import {
  DiscoveredModel,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../types.js';
import { WorkerAdapter, WorkerAdapterError, WorkerPlatformInfo } from './worker-adapter.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_FREEBUFF_PATH = 'freebuff';

export class FreebuffAdapter implements WorkerAdapter {
  readonly platformId = 'freebuff';
  readonly supportsCrossModelSessionContinuation = false;
  private freebuffExecutable: string;
  private processManager: ProcessManager;

  constructor(
    freebuffExecutable = DEFAULT_FREEBUFF_PATH,
    processManager?: ProcessManager
  ) {
    this.freebuffExecutable = freebuffExecutable;
    this.processManager = processManager || new ProcessManager();
  }

  getExecutablePath(): string {
    return this.freebuffExecutable;
  }

  getJobLogFilePath(jobId: string): string {
    const logsDir = path.join(USER_BRIDGE_DIR, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${jobId}-freebuff.log`);
  }

  async inspectEnvironment(): Promise<WorkerPlatformInfo> {
    const readMetadataVersion = (): string | undefined => {
      try {
        const metadataPath = path.join(
          process.env.USERPROFILE || process.env.HOME || '',
          '.config',
          'manicode',
          'freebuff-metadata.json'
        );
        if (fs.existsSync(metadataPath)) {
          const data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (data && typeof data.version === 'string') return data.version;
        }
      } catch {}
      return undefined;
    };

    const readPackageJsonVersion = (): string | undefined => {
      try {
        const npmPackageJson = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'freebuff', 'package.json');
        if (fs.existsSync(npmPackageJson)) {
          const pkg = JSON.parse(fs.readFileSync(npmPackageJson, 'utf8'));
          if (pkg && typeof pkg.version === 'string') return pkg.version;
        }
      } catch {}
      return undefined;
    };

    const tryRunVersion = async (exe: string): Promise<string | undefined> => {
      try {
        const invocation = getSafeProcessInvocation(exe, ['--version']);
        const { stdout } = await execFileAsync(invocation.executable, invocation.args, {
          windowsHide: true,
          shell: false,
          timeout: 2000,
        });
        const trimmed = stdout.trim();
        return trimmed || undefined;
      } catch {
        return undefined;
      }
    };

    const versionFromPackage = readPackageJsonVersion();
    const versionFromMetadata = readMetadataVersion();
    const resolvedVersion = versionFromPackage || versionFromMetadata || '0.0.149';

    const nativeBinary = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.config',
      'manicode',
      process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'
    );
    if (fs.existsSync(nativeBinary)) {
      const ver = (await tryRunVersion(nativeBinary)) || resolvedVersion;
      return {
        platformId: this.platformId,
        displayName: 'Freebuff',
        installed: true,
        version: ver,
        executablePath: nativeBinary,
      };
    }

    if (process.platform === 'win32') {
      const npmCmd = path.join(process.env.APPDATA || '', 'npm', 'freebuff.cmd');
      if (fs.existsSync(npmCmd)) {
        return {
          platformId: this.platformId,
          displayName: 'Freebuff',
          installed: true,
          version: resolvedVersion,
          executablePath: npmCmd,
        };
      }
    }

    // Direct invocation check
    const directVersion = await tryRunVersion(this.freebuffExecutable);
    if (directVersion) {
      return {
        platformId: this.platformId,
        displayName: 'Freebuff',
        installed: true,
        version: directVersion,
        executablePath: this.freebuffExecutable,
      };
    }

    if (process.platform === 'win32') {
      try {
        const { stdout: whereOut } = await execFileAsync('where.exe', ['freebuff.cmd', 'freebuff.exe', 'freebuff'], {
          windowsHide: true,
          timeout: 2000,
        });
        const foundPath = whereOut.split(/\r?\n/)[0]?.trim();
        if (foundPath && fs.existsSync(foundPath)) {
          return {
            platformId: this.platformId,
            displayName: 'Freebuff',
            installed: true,
            version: resolvedVersion,
            executablePath: foundPath,
          };
        }
      } catch {}
    }

    return {
      platformId: this.platformId,
      displayName: 'Freebuff',
      installed: false,
      executablePath: this.freebuffExecutable,
      error: `FREEBUFF_CLI_MISSING: Freebuff executable was not found at "${this.freebuffExecutable}".`,
    };
  }

  async discoverModels(_refresh = false): Promise<DiscoveredModel[]> {
    // Freebuff models are provider-managed; model catalog identities are not bound to individual CLI worker models.
    return [];
  }

  async resolveReasoningProfile(
    _modelId: string,
    _requestedStrategy?: 'highest-supported' | 'explicit' | 'provider-managed',
    _explicitValue?: string
  ): Promise<string | undefined> {
    // Freebuff reasoning effort is provider-managed.
    return undefined;
  }

  async probeQuota(_modelId?: string): Promise<QuotaProbeResult> {
    // Qualification gate: Upstream Freebuff CLI currently has no supported non-interactive task-delivery seam.
    return {
      state: 'ERROR',
      failureClass: 'AUTOMATION_SEAM_UNAVAILABLE',
      details: 'Freebuff CLI currently has no supported non-interactive task-delivery seam (interactive TUI only).',
    };
  }

  async validateExecutionContext(request: WorkerInvocationRequest): Promise<void> {
    if (request.executionMode === 'READ_ONLY') {
      throw new WorkerAdapterError('PERMISSION_BLOCKED', 'Freebuff does not support mechanical READ_ONLY execution.');
    }
    throw new WorkerAdapterError(
      'AUTOMATION_SEAM_UNAVAILABLE',
      'Freebuff CLI currently has no supported non-interactive task-delivery seam (interactive TUI only).'
    );
  }

  async invokeWorker(_request: WorkerInvocationRequest): Promise<WorkerRoundResult> {
    throw new WorkerAdapterError(
      'AUTOMATION_SEAM_UNAVAILABLE',
      'Freebuff CLI currently has no supported non-interactive task-delivery seam (interactive TUI only).'
    );
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.processManager.cancelJob(jobId);
  }
}
