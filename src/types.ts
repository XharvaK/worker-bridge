/**
 * Core type definitions for Worker Bridge.
 */

export type JobPhase = 'PLAN' | 'IMPLEMENT' | 'CANCEL';

export type JobIntent =
  | 'plan'
  | 'design'
  | 'investigate'
  | 'implement'
  | 'fix'
  | 'review'
  | 'audit';

export type ExecutionMode = 'READ_ONLY' | 'WORKTREE_WRITE';

export type JobState =
  | 'PENDING'
  | 'DRAFT'
  | 'WORKER_REQUESTED'
  | 'WORKER_RUNNING'
  | 'WORKER_RETURNED'
  | 'SOL_REVIEWED'
  | 'AWAITING_OWNER'
  | 'OWNER_APPROVED'
  | 'PLANNING'
  | 'PLAN_READY'
  | 'IMPLEMENTING'
  | 'IMPLEMENTATION_READY'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'INTERRUPTED_WITH_SOURCE_STATE';

export type SessionPolicy = 'CONTINUE' | 'FRESH';

export type WorkerRole = 'INVESTIGATOR' | 'WORKER' | 'REVIEWER';
export type LegacyWorkerRole = WorkerRole | 'PLANNER';

export interface OrchestratorInfo {
  surface?: string;
  role?: string;
  modelHint?: string;
}

export interface TrustedRequestContext {
  originSurface?: string;
  lineageParentJobId?: string;
}

export type ReasoningStrategy = 'highest-supported' | 'explicit' | 'provider-managed';

export interface ReasoningConfig {
  strategy: ReasoningStrategy;
  value?: string;
}

export type ModelBinding = 'FIXED' | 'EXPLICIT_DISCOVERED' | 'PROVIDER_MANAGED';
export type ModelSelectability = 'SELECTABLE' | 'NOT_SELECTABLE' | 'UNKNOWN';
export type ReasoningTopology = 'ORDINARY' | 'TOPOLOGY_CHANGING' | 'UNKNOWN';

export interface DiscoveredReasoningProfile {
  value: string;
  topology: ReasoningTopology;
  description?: string;
}

export interface ExplicitFallbackSelection {
  targetId?: string;
  platform?: string;
  model?: string;
  reasoning?: ReasoningConfig;
}

export interface WorkerSelection {
  targetId?: string;
  platform?: string;
  model?: string;
  reasoning?: ReasoningConfig;
  allowFallback?: boolean;
  avoidTargetId?: string;
  fallbackSelection?: ExplicitFallbackSelection;
}

export interface RecoveryRequest {
  enabled: boolean;
  fromRound?: number;
  capsulePath?: string;
}

export interface OwnerApproval {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
}

export interface WorkJob {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  baseSha: string;
  intent: JobIntent;
  executionMode: ExecutionMode;
  round: number;
  revision: number;
  role?: WorkerRole;
  workerSelection?: WorkerSelection;
  sessionPolicy?: SessionPolicy;
  recovery?: RecoveryRequest;
  targetBranch?: string;
  timeoutSeconds?: number;
  ownerApproval?: OwnerApproval;
  createdAt?: string;
  // Legacy v1 compat fields
  requestedPhase?: JobPhase;
}

// Alias JobSpec to WorkJob for backward compatibility
export type JobSpec = WorkJob;

export interface WorkerIdentity {
  targetId?: string;
  platform: string;
  model: string;
  variant?: string;
  reasoning?: string;
  platformSessionId?: string;
  worktreeCwd?: string;
  executionMode?: ExecutionMode;
}

export interface JobStatus {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  observedRound: number;
  observedRevision: number;
  state: JobState;
  updatedAt: string;
  baseSha: string;
  currentWorker?: WorkerIdentity | null;
  workerBranch?: string | null;
  headSha?: string | null;
  recoveryCapsulePath?: string | null;
  exitCode?: number | null;
  summary?: string;
  error?: string | null;
  blockers?: string[];
  // Legacy v1 compat fields
  observedPhase?: JobPhase;
}

export interface ProjectConfig {
  path: string;
  allowed: boolean;
  defaultBranch?: string;
  allowPushWorkerBranch?: boolean;
  testCommand?: string;
  buildCommand?: string;
}

export interface PlatformConfig {
  enabled?: boolean;
  executable?: string;
  defaultModel?: string;
  env?: Record<string, string>;
}

export interface ModelAliasConfig {
  platform: string;
  catalogId?: string;
  displayName?: string;
  defaultVariant?: string;
  isExplicitOnly?: boolean;
}

export interface WorkerTargetConfig {
  targetId: string;
  platformId: string;
  modelId?: string;
  displayName: string;
  aliases?: string[];
  reasoning: ReasoningConfig;
  explicitOnly?: boolean;
  modelBinding?: ModelBinding;
}

export interface SelectionPolicyConfig {
  targets: Record<string, WorkerTargetConfig>;
  roleRankings: Partial<Record<WorkerRole, string[]>>;
  allowFallbackByDefault?: boolean;
  maxFallbackAttempts?: number;
  reviewerPreferDifferentTarget?: boolean;
}

export type TargetAvailabilityState =
  | 'AVAILABLE'
  | 'LOW'
  | 'EXHAUSTED'
  | 'COOLDOWN'
  | 'ELIGIBLE_TO_RETRY'
  | 'UNKNOWN'
  | 'ERROR';

export interface TargetAvailabilityRecord {
  targetId: string;
  platformId: string;
  modelId: string;
  state: TargetAvailabilityState;
  failureClass?: OperationalFailureClass;
  observedAt: string;
  retryAt?: string;
  rawEvidence?: string;
  source?: string;
}

export interface BridgeConfig {
  mailboxRepoPath: string;
  mailboxRemote?: string;
  pollIntervalSeconds?: number;
  workerRootDir: string;
  platforms?: Record<string, PlatformConfig>;
  modelAliases?: Record<string, ModelAliasConfig>;
  selectionPolicy?: SelectionPolicyConfig;
  pushWorkerBranches: boolean;
  notificationsEnabled: boolean;
  allowedProjects: Record<string, ProjectConfig>;
  // Legacy v1 fields
  agyExecutable?: string;
  workerModel?: string;
}

export interface LedgerJobRecord {
  jobId: string;
  projectId: string;
  lastHandledRound: number;
  lastHandledRevision: number;
  lastHandledMode: ExecutionMode;
  lastHandledIntent: JobIntent;
  platform?: string;
  model?: string;
  reasoning?: string;
  targetId?: string;
  role?: LegacyWorkerRole | string;
  platformSessionId?: string | null;
  state: JobState;
  startedAt: string;
  finishedAt?: string | null;
  lastKnownPid?: number | null;
  worktreePath?: string | null;
  workerBranch?: string | null;
  sourceEffectsPresent?: boolean;
  recoveryCapsulePath?: string | null;
  currentHeadSha?: string | null;
  // Legacy v1 fields
  lastHandledPhase?: JobPhase;
}

export interface LedgerData {
  version: number;
  jobs: Record<string, LedgerJobRecord>;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  family?: string;
  variants: string[];
  highestVariant?: string;
  reasoningProfiles?: DiscoveredReasoningProfile[];
  selectability?: ModelSelectability;
  contextLimit?: number;
  isExplicitOnly?: boolean;
}

export type QuotaState = 'AVAILABLE' | 'LOW' | 'EXHAUSTED' | 'UNKNOWN' | 'ERROR';

export interface QuotaProbeResult {
  state: QuotaState;
  remainingPercentage?: number;
  resetsAt?: string;
  details?: string;
  failureClass?: OperationalFailureClass;
}

export interface WorkerInvocationRequest {
  jobId: string;
  roundNumber: number;
  executionMode: ExecutionMode;
  worktreeCwd: string;
  promptText: string;
  targetId?: string;
  modelId: string;
  variant?: string;
  sessionId?: string;
  sessionIdentity?: WorkerSessionIdentity;
  timeoutSeconds?: number;
}

export type OperationalFailureClass =
  | 'CLI_MISSING'
  | 'AUTH_REQUIRED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_DISCOVERY_UNAVAILABLE'
  | 'MODEL_NOT_SELECTABLE'
  | 'REASONING_PROFILE_UNSUPPORTED'
  | 'SESSION_ID_UNAVAILABLE'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'PERMISSION_BLOCKED'
  | 'RECURSION_BLOCKED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROCESS_FAILED'
  | 'OUTPUT_INVALID'
  | 'INTERRUPTED'
  | 'AUTOMATION_SEAM_UNAVAILABLE'
  | 'UNKNOWN';

export interface WorkerRoundResult {
  platformId: string;
  modelId: string;
  variant?: string;
  platformSessionId?: string;
  exitCode: number;
  responseText: string;
  artifactsCreated: string[];
  toolSummary?: Record<string, number>;
  startedAt: string;
  completedAt: string;
  failureClass?: OperationalFailureClass;
  retryAt?: string;
  rawFailureEvidence?: string;
  requestPrompt?: string;
  evidence?: WorkerEvidence;
  rawStderr?: string;
  sessionIdentity?: WorkerSessionIdentity;
}

export interface WorkerSessionIdentity {
  targetId?: string;
  platform: string;
  model: string;
  reasoning?: string;
  sessionId?: string;
  worktreeCwd: string;
  executionMode: ExecutionMode;
}

export interface WorkerEvidence {
  stdout: string;
  stderr: string;
  partialResponse: string;
  outputTruncated: boolean;
  toolSummary?: Record<string, number>;
  sessionId?: string;
  lastMeaningfulAction?: string;
}

export interface RecoveryContract {
  jobId: string;
  round: number;
  revision: number;
  role: WorkerRole;
  originalGoal: string;
  acceptedPlan: string;
  solReview: string;
  ownerApproval?: OwnerApproval;
  baseSha: string;
  executionMode?: ExecutionMode;
  executionConstraints: string[];
}

export interface RecoverySourceWorker {
  targetId?: string;
  platform: string;
  model: string;
  reasoning?: string;
  sessionId?: string;
  requestPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  failureClass?: OperationalFailureClass;
  retryAt?: string;
}

export interface RecoveryCurrentState {
  worktreePath: string;
  branch?: string;
  baseSha: string;
  headSha?: string;
  inspectionFailed?: boolean;
  gitStatus: string;
  gitDiff: string;
  gitDiffStat: string;
  diffCheck: string;
  filesChanged: string[];
  bridgeVerification: Record<string, string>;
  incompleteOperations: string[];
}

export interface RecoveryDirective {
  provenComplete: string[];
  appearsIncomplete: string[];
  knownFailures: string[];
  remainingWork: string[];
  mustNotRepeatBlindly: string[];
  instruction: string;
}

export interface RecoveryCapsuleInput {
  contract: RecoveryContract;
  sourceWorker: RecoverySourceWorker;
  capturedHistory: WorkerEvidence;
  currentState: RecoveryCurrentState;
  recoveryDirective: RecoveryDirective;
}

export interface RecoveryCapsule extends RecoveryCapsuleInput {
  schemaVersion: 1;
  generatedAt: string;
}

export interface PlanResult {
  jobId: string;
  projectId: string;
  baseSha: string;
  platform: string;
  model: string;
  variant?: string;
  sessionId?: string;
  sessionIdentity?: WorkerSessionIdentity;
  worktreePath?: string;
  targetId?: string;
  planText: string;
  exitCode: number;
  clean: boolean;
  mutatedFiles: string[];
  failureClass?: OperationalFailureClass;
  retryAt?: string;
  rawFailureEvidence?: string;
  evidence?: WorkerEvidence;
  recoveryEvidence?: RecoveryCapsule;
  error?: string;
}

export interface ImplementResult {
  jobId: string;
  projectId: string;
  baseSha: string;
  platform: string;
  model: string;
  variant?: string;
  sessionId?: string;
  sessionIdentity?: WorkerSessionIdentity;
  targetId?: string;
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
  failureClass?: OperationalFailureClass;
  retryAt?: string;
  rawFailureEvidence?: string;
  sourceEffectsPresent: boolean;
  worktreePath?: string;
  currentHeadSha?: string;
  recoveryEvidence?: RecoveryCapsule;
  recoveryCapsulePath?: string;
  error?: string;
  reportText: string;
}

export interface AgyPermissionProfile {
  executionMode: ExecutionMode;
  allowSourceWrites: boolean;
  allowNetworkActuation: boolean;
  allowElevation: boolean;
  allowSsh: boolean;
  allowGitPush: boolean;
  sandboxed: boolean;
}
