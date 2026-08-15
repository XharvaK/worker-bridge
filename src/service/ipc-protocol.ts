import * as os from 'node:os';
import * as path from 'node:path';
import { ExecutionMode, JobIntent, JobState, ReasoningConfig } from '../types.js';

export type IpcMethod =
  | 'list_targets'
  | 'start_job'
  | 'get_job'
  | 'get_result'
  | 'cancel_job'
  | 'prepare_project'
  | 'approve_job'
  | 'shutdown';

export interface IpcRequest<T = Record<string, unknown>> {
  requestId: string;
  method: IpcMethod;
  params: T;
}

export interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}

export interface IpcResponse<T = unknown> {
  requestId: string;
  result?: T;
  error?: IpcError;
}

export const MAX_IPC_MESSAGE_BYTES = 1024 * 1024; // 1 MB

export function getServicePipePath(customName?: string): string {
  let user = 'default';
  try {
    user = (os.userInfo().username || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  } catch {
    user = 'default';
  }
  const suffix = customName ? `-${customName}` : '';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\worker-bridge-${user}${suffix}`;
  }
  return path.join(os.tmpdir(), `worker-bridge-${user}${suffix}.sock`);
}

export function serializeIpcMessage(message: IpcRequest | IpcResponse): string {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, 'utf8') > MAX_IPC_MESSAGE_BYTES) {
    throw new Error(`MESSAGE_TOO_LARGE: IPC message exceeds limit of ${MAX_IPC_MESSAGE_BYTES} bytes.`);
  }
  return `${json}\n`;
}

export function parseIpcMessage<T = IpcRequest | IpcResponse>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('INVALID_IPC_MESSAGE: Empty message received.');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_IPC_MESSAGE_BYTES) {
    throw new Error(`MESSAGE_TOO_LARGE: IPC message exceeds limit of ${MAX_IPC_MESSAGE_BYTES} bytes.`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(`INVALID_IPC_MESSAGE: Failed to parse JSON: ${String(error)}`);
  }
}

// Param & Result Types for Tools
export interface ListTargetsResult {
  targets: Array<{
    targetId: string;
    platformId: string;
    displayName: string;
    explicitOnly?: boolean;
    modelBinding?: string;
    available: boolean;
    reasoningStrategy?: string;
  }>;
}

export interface StartJobParams {
  clientRequestId: string;
  projectPath: string;
  intent: JobIntent;
  executionMode: ExecutionMode;
  goal: string;
  plan?: string;
  review?: string;
  workerSelection?: {
    targetId?: string;
    platform?: string;
    model?: string;
    reasoning?: ReasoningConfig | string;
  };
  timeoutSeconds?: number;
  baseSha?: string;
  excludedPlatforms?: string[];
}

export interface StartJobResult {
  jobId: string;
  state: JobState;
  executionMode: ExecutionMode;
  requiresOwnerApproval: boolean;
  approvalChallenge?: string;
}

export interface GetJobParams {
  jobId: string;
}

export interface GetJobResult {
  jobId: string;
  state: JobState;
  executionMode: ExecutionMode;
  intent?: JobIntent;
  target?: string;
  platform?: string;
  model?: string;
  reasoning?: string;
  summary?: string;
  verification?: string;
  changedFiles?: string[];
  diffStat?: string;
  recoveryStatus?: string;
  requiresOwnerApproval?: boolean;
  approvalChallenge?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GetResultParams {
  jobId: string;
  offset?: number;
  limit?: number;
}

export interface GetResultResult {
  jobId: string;
  state: JobState;
  resultText: string;
  totalBytes: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface CancelJobParams {
  jobId: string;
}

export interface CancelJobResult {
  jobId: string;
  previousState: JobState;
  newState: JobState;
  sourceEffectsPresent: boolean;
  recoveryRequired: boolean;
}

export interface PrepareProjectParams {
  projectPath?: string;
  remote?: string;
  destinationName?: string;
  ref?: string;
  syncMode?: 'none' | 'fetch' | 'fast-forward';
}

export interface PrepareProjectResult {
  projectPath: string;
  status: 'ready' | 'cloned' | 'synced';
  baseSha: string;
  branch: string;
  clean: boolean;
}

export interface ApproveJobParams {
  challenge: string;
}

export interface ApproveJobResult {
  jobId: string;
  approved: boolean;
  state: JobState;
}
