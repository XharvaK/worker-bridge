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
const VALID_ROLES = new Set<WorkerRole>(['INVESTIGATOR', 'WORKER', 'REVIEWER']);
const VALID_REASONING_STRATEGIES = new Set(['highest-supported', 'explicit']);

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
      return { valid: false, error: `Invalid role: "${parsed.role}". Expected INVESTIGATOR, WORKER, or REVIEWER.` };
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

  const workerSelection = validateWorkerSelection(parsed.workerSelection);
  if (!workerSelection.valid) {
    return { valid: false, error: workerSelection.error };
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
    workerSelection: workerSelection.value,
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

function validateWorkerSelection(raw: unknown): { valid: true; value?: WorkJob['workerSelection'] } | { valid: false; error: string } {
  if (raw === undefined) return { valid: true };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'Invalid workerSelection: expected an object.' };
  }

  const selection = raw as Record<string, unknown>;
  for (const key of ['targetId', 'platform', 'model', 'avoidTargetId']) {
    if (selection[key] !== undefined && typeof selection[key] !== 'string') {
      return { valid: false, error: `Invalid workerSelection.${key}: expected a string.` };
    }
  }
  if (selection.reasoning !== undefined && !isValidReasoningConfig(selection.reasoning)) {
    return { valid: false, error: 'Invalid workerSelection.reasoning.' };
  }
  if (selection.fallbackSelection !== undefined) {
    const fallback = selection.fallbackSelection;
    if (
      typeof fallback !== 'object' || fallback === null || Array.isArray(fallback) ||
      Object.prototype.hasOwnProperty.call(fallback, 'fallbackSelection') ||
      Object.prototype.hasOwnProperty.call(fallback, 'allowFallback')
    ) {
      return { valid: false, error: 'Invalid fallbackSelection: it must be a bounded nonrecursive selection.' };
    }
    const fallbackRecord = fallback as Record<string, unknown>;
    const identifiers = ['targetId', 'platform', 'model'];
    if (!identifiers.some((key) => typeof fallbackRecord[key] === 'string' && fallbackRecord[key].length > 0)) {
      return { valid: false, error: 'Invalid fallbackSelection: at least one targetId, platform, or model is required.' };
    }
    for (const key of identifiers) {
      if (fallbackRecord[key] !== undefined && typeof fallbackRecord[key] !== 'string') {
        return { valid: false, error: `Invalid fallbackSelection.${key}: expected a string.` };
      }
    }
    if (fallbackRecord.reasoning !== undefined && !isValidReasoningConfig(fallbackRecord.reasoning)) {
      return { valid: false, error: 'Invalid fallbackSelection.reasoning.' };
    }
  }

  return { valid: true, value: selection as WorkJob['workerSelection'] };
}

function isValidReasoningConfig(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const reasoning = raw as Record<string, unknown>;
  if (typeof reasoning.strategy !== 'string' || !VALID_REASONING_STRATEGIES.has(reasoning.strategy)) return false;
  if (reasoning.value !== undefined && (typeof reasoning.value !== 'string' || !reasoning.value)) return false;
  return reasoning.strategy !== 'explicit' || typeof reasoning.value === 'string' && reasoning.value.length > 0;
}

export function formatStatusJson(status: JobStatus): string {
  return JSON.stringify(status, null, 2);
}
