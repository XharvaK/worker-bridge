import {
  WorkJob,
  JobStatus,
  JobIntent,
  ExecutionMode,
  JobPhase,
  SessionPolicy,
  WorkerRole,
} from '../types.js';

const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA_REGEX = /^[a-fA-F0-9]{7,40}$/;
const VALID_V1_PHASES = new Set(['PLAN', 'IMPLEMENT', 'CANCEL']);
const VALID_INTENTS = new Set<JobIntent>(['plan', 'design', 'investigate', 'implement', 'fix', 'review', 'audit']);
const VALID_MODES = new Set<ExecutionMode>(['READ_ONLY', 'WORKTREE_WRITE']);
const VALID_SESSION_POLICIES = new Set<SessionPolicy>(['CONTINUE', 'FRESH']);
const VALID_ROLES = new Set<WorkerRole>(['PLANNER', 'INVESTIGATOR', 'WORKER', 'REVIEWER']);

export function parseJobSpec(rawContent: string): { valid: boolean; spec?: WorkJob; error?: string } {
  if (!rawContent || typeof rawContent !== 'string') {
    return { valid: false, error: 'Empty or invalid job spec content' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    return { valid: false, error: `Invalid JSON syntax: ${String(err)}` };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, error: 'Job spec must be a JSON object' };
  }

  const schemaVersion = parsed.schemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return { valid: false, error: `Unsupported schemaVersion: ${schemaVersion}. Expected 1 or 2.` };
  }

  if (!parsed.jobId || typeof parsed.jobId !== 'string' || !JOB_ID_REGEX.test(parsed.jobId)) {
    return { valid: false, error: `Invalid jobId: "${parsed.jobId}". Must be 3-64 alphanumeric characters, dashes, or underscores.` };
  }

  if (!parsed.projectId || typeof parsed.projectId !== 'string' || !PROJECT_ID_REGEX.test(parsed.projectId)) {
    return { valid: false, error: `Invalid projectId: "${parsed.projectId}".` };
  }

  if (!parsed.baseSha || typeof parsed.baseSha !== 'string' || !SHA_REGEX.test(parsed.baseSha.trim())) {
    return { valid: false, error: `Invalid baseSha: "${parsed.baseSha}". Must be a valid git commit SHA.` };
  }

  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 1) {
    return { valid: false, error: `Invalid revision: ${parsed.revision}. Must be an integer >= 1.` };
  }

  let intent: JobIntent = 'plan';
  let executionMode: ExecutionMode = 'READ_ONLY';
  let round = 1;
  let requestedPhase: JobPhase | undefined;
  let role: WorkerRole | undefined;

  if (schemaVersion === 1 || parsed.requestedPhase) {
    // V1 Schema compatibility
    if (!parsed.requestedPhase || !VALID_V1_PHASES.has(parsed.requestedPhase)) {
      return { valid: false, error: `Invalid requestedPhase: "${parsed.requestedPhase}". Expected PLAN, IMPLEMENT, or CANCEL.` };
    }
    requestedPhase = parsed.requestedPhase as JobPhase;
    round = typeof parsed.round === 'number' && parsed.round >= 1 ? parsed.round : 1;

    if (requestedPhase === 'PLAN') {
      intent = 'plan';
      executionMode = 'READ_ONLY';
    } else if (requestedPhase === 'IMPLEMENT') {
      intent = 'implement';
      executionMode = 'WORKTREE_WRITE';
    } else if (requestedPhase === 'CANCEL') {
      intent = 'audit';
      executionMode = 'READ_ONLY';
    }
  } else {
    // V2 Schema
    if (!parsed.intent || !VALID_INTENTS.has(parsed.intent)) {
      return { valid: false, error: `Invalid intent: "${parsed.intent}". Expected one of: ${Array.from(VALID_INTENTS).join(', ')}.` };
    }
    intent = parsed.intent as JobIntent;

    if (!parsed.executionMode || !VALID_MODES.has(parsed.executionMode)) {
      return { valid: false, error: `Invalid executionMode: "${parsed.executionMode}". Expected READ_ONLY or WORKTREE_WRITE.` };
    }
    executionMode = parsed.executionMode as ExecutionMode;

    if (typeof parsed.round !== 'number' || !Number.isInteger(parsed.round) || parsed.round < 1) {
      return { valid: false, error: `Invalid round: ${parsed.round}. Must be an integer >= 1.` };
    }
    round = parsed.round;
  }

  if (parsed.role !== undefined) {
    if (typeof parsed.role !== 'string' || !VALID_ROLES.has(parsed.role as WorkerRole)) {
      return { valid: false, error: `Invalid role: "${parsed.role}". Expected PLANNER, INVESTIGATOR, WORKER, or REVIEWER.` };
    }
    role = parsed.role as WorkerRole;
  }

  let sessionPolicy: SessionPolicy | undefined;
  if (parsed.sessionPolicy) {
    if (!VALID_SESSION_POLICIES.has(parsed.sessionPolicy)) {
      return { valid: false, error: `Invalid sessionPolicy: "${parsed.sessionPolicy}". Expected CONTINUE or FRESH.` };
    }
    sessionPolicy = parsed.sessionPolicy as SessionPolicy;
  }

  if (parsed.recovery !== undefined) {
    if (typeof parsed.recovery !== 'object' || parsed.recovery === null || typeof parsed.recovery.enabled !== 'boolean') {
      return { valid: false, error: 'Invalid recovery: expected an object with boolean enabled.' };
    }
    if (
      parsed.recovery.fromRound !== undefined &&
      (!Number.isInteger(parsed.recovery.fromRound) || parsed.recovery.fromRound < 1)
    ) {
      return { valid: false, error: `Invalid recovery.fromRound: ${parsed.recovery.fromRound}.` };
    }
  }

  const spec: WorkJob = {
    schemaVersion,
    jobId: parsed.jobId,
    projectId: parsed.projectId,
    baseSha: parsed.baseSha.trim(),
    intent,
    executionMode,
    round,
    revision: parsed.revision,
    role,
    workerSelection: parsed.workerSelection,
    sessionPolicy,
    recovery: parsed.recovery,
    targetBranch: parsed.targetBranch,
    timeoutSeconds: typeof parsed.timeoutSeconds === 'number' && parsed.timeoutSeconds > 0 ? parsed.timeoutSeconds : 900,
    ownerApproval: parsed.ownerApproval,
    createdAt: parsed.createdAt || new Date().toISOString(),
    requestedPhase,
  };

  return { valid: true, spec };
}

export function formatStatusJson(status: JobStatus): string {
  return JSON.stringify(status, null, 2);
}
