/**
 * Core type definitions for Gemini Worker Bridge.
 */

export type JobPhase = 'PLAN' | 'IMPLEMENT' | 'CANCEL';

export type JobState =
  | 'NEW'
  | 'PLANNING'
  | 'PLAN_READY'
  | 'IMPLEMENTING'
  | 'IMPLEMENTATION_READY'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export interface JobSpec {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  baseSha: string;
  requestedPhase: JobPhase;
  revision: number;
  createdAt: string;
  targetBranch?: string;
  timeoutSeconds?: number;
}

export interface JobStatus {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  observedPhase: JobPhase;
  observedRevision: number;
  state: JobState;
  updatedAt: string;
  baseSha: string;
  workerBranch?: string | null;
  headSha?: string | null;
  exitCode?: number | null;
  summary?: string;
  error?: string | null;
  blockers?: string[];
}

export interface ProjectConfig {
  path: string;
  allowed: boolean;
  defaultBranch?: string;
  allowPushWorkerBranch?: boolean;
  testCommand?: string;
  buildCommand?: string;
}

export interface BridgeConfig {
  mailboxRepoPath: string;
  mailboxRemote?: string;
  pollIntervalSeconds?: number;
  workerRootDir: string;
  agyExecutable: string;
  workerModel: string;
  pushWorkerBranches: boolean;
  notificationsEnabled: boolean;
  allowedProjects: Record<string, ProjectConfig>;
}

export interface LedgerJobRecord {
  jobId: string;
  projectId: string;
  lastHandledRevision: number;
  lastHandledPhase: JobPhase;
  state: JobState;
  startedAt: string;
  finishedAt?: string | null;
  lastKnownPid?: number | null;
  worktreePath?: string | null;
  workerBranch?: string | null;
}

export interface LedgerData {
  version: number;
  jobs: Record<string, LedgerJobRecord>;
}

export interface PlanResult {
  jobId: string;
  projectId: string;
  baseSha: string;
  model: string;
  planText: string;
  exitCode: number;
  clean: boolean;
  mutatedFiles: string[];
  error?: string;
}

export interface ImplementResult {
  jobId: string;
  projectId: string;
  baseSha: string;
  workerBranch: string;
  headSha?: string;
  filesChanged: string[];
  testsRun: boolean;
  testOutput?: string;
  testExitCode?: number;
  bridgeVerificationPassed: boolean;
  diffCheckPassed: boolean;
  dirtyRemaining: boolean;
  exitCode: number;
  error?: string;
  reportText: string;
}

export interface AgyPermissionProfile {
  phase: JobPhase;
  allowSourceWrites: boolean;
  allowNetworkActuation: boolean;
  allowElevation: boolean;
  allowSsh: boolean;
  allowGitPush: boolean;
  sandboxed: boolean;
}
