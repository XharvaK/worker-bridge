import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  RecoveryCapsule,
  RecoveryCapsuleInput,
  RecoveryCurrentState,
} from '../types.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';

const execFileAsync = promisify(execFile);
const MAX_CAPSULE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 12 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024;
const MAX_ARRAY_ITEMS = 64;

function boundText(value: unknown, maxBytes = MAX_TEXT_BYTES): string {
  const sanitized = sanitizeSecrets(String(value ?? ''));
  if (Buffer.byteLength(sanitized, 'utf8') <= maxBytes) return sanitized;

  const marker = '\n...[bounded]...\n';
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const firstBytes = Math.ceil(available / 2);
  const lastBytes = Math.floor(available / 2);
  const first = Buffer.from(sanitized, 'utf8').subarray(0, firstBytes).toString('utf8');
  const last = Buffer.from(sanitized, 'utf8').subarray(-lastBytes).toString('utf8');
  return `${first}${marker}${last}`.slice(0, maxBytes);
}

function boundArray(values: unknown, maxItems = MAX_ARRAY_ITEMS, maxItemBytes = 2000): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, maxItems).map((value) => boundText(value, maxItemBytes));
}

function boundMap(values: unknown): Record<string, number> | undefined {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values).slice(0, MAX_ARRAY_ITEMS)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[boundText(key, 200)] = value;
    }
  }
  return result;
}

function boundVerification(values: unknown, maxItems = MAX_ARRAY_ITEMS, maxValueBytes = 2000): Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values)
      .slice(0, maxItems)
      .map(([key, value]) => [boundText(key, 500), boundText(value, maxValueBytes)])
  );
}

function sanitizeCapsule(input: RecoveryCapsuleInput): RecoveryCapsule {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contract: {
      jobId: boundText(input.contract.jobId, 500),
      round: input.contract.round,
      revision: input.contract.revision,
      role: input.contract.role,
      originalGoal: boundText(input.contract.originalGoal),
      acceptedPlan: boundText(input.contract.acceptedPlan),
      solReview: boundText(input.contract.solReview),
      ownerApproval: input.contract.ownerApproval
        ? {
            approved: input.contract.ownerApproval.approved,
            approvedBy: boundText(input.contract.ownerApproval.approvedBy, 500) || undefined,
            approvedAt: boundText(input.contract.ownerApproval.approvedAt, 500) || undefined,
            notes: boundText(input.contract.ownerApproval.notes, 2000) || undefined,
          }
        : undefined,
      baseSha: boundText(input.contract.baseSha, 500),
      executionConstraints: boundArray(input.contract.executionConstraints),
    },
    sourceWorker: {
      targetId: boundText(input.sourceWorker.targetId, 500) || undefined,
      platform: boundText(input.sourceWorker.platform, 500),
      model: boundText(input.sourceWorker.model, 1000),
      reasoning: boundText(input.sourceWorker.reasoning, 500) || undefined,
      sessionId: boundText(input.sourceWorker.sessionId, 1000) || undefined,
      requestPrompt: boundText(input.sourceWorker.requestPrompt, MAX_EVIDENCE_BYTES) || undefined,
      startedAt: boundText(input.sourceWorker.startedAt, 500) || undefined,
      endedAt: boundText(input.sourceWorker.endedAt, 500) || undefined,
      failureClass: input.sourceWorker.failureClass,
      retryAt: boundText(input.sourceWorker.retryAt, 500) || undefined,
    },
    capturedHistory: {
      stdout: boundText(input.capturedHistory.stdout, MAX_EVIDENCE_BYTES),
      stderr: boundText(input.capturedHistory.stderr, MAX_EVIDENCE_BYTES),
      partialResponse: boundText(input.capturedHistory.partialResponse, MAX_EVIDENCE_BYTES),
      outputTruncated: Boolean(input.capturedHistory.outputTruncated),
      toolSummary: boundMap(input.capturedHistory.toolSummary),
      sessionId: boundText(input.capturedHistory.sessionId, 1000) || undefined,
      lastMeaningfulAction: boundText(input.capturedHistory.lastMeaningfulAction, 2000) || undefined,
    },
    currentState: {
      worktreePath: boundText(input.currentState.worktreePath, 2000),
      branch: boundText(input.currentState.branch, 1000) || undefined,
      baseSha: boundText(input.currentState.baseSha, 500),
      headSha: boundText(input.currentState.headSha, 500) || undefined,
      inspectionFailed: Boolean(input.currentState.inspectionFailed),
      gitStatus: boundText(input.currentState.gitStatus),
      gitDiff: boundText(input.currentState.gitDiff),
      gitDiffStat: boundText(input.currentState.gitDiffStat),
      diffCheck: boundText(input.currentState.diffCheck),
      filesChanged: boundArray(input.currentState.filesChanged),
      bridgeVerification: boundVerification(input.currentState.bridgeVerification),
      incompleteOperations: boundArray(input.currentState.incompleteOperations),
    },
    recoveryDirective: {
      provenComplete: boundArray(input.recoveryDirective.provenComplete),
      appearsIncomplete: boundArray(input.recoveryDirective.appearsIncomplete),
      knownFailures: boundArray(input.recoveryDirective.knownFailures),
      remainingWork: boundArray(input.recoveryDirective.remainingWork),
      mustNotRepeatBlindly: boundArray(input.recoveryDirective.mustNotRepeatBlindly),
      instruction: boundText(input.recoveryDirective.instruction, 4000),
    },
  };
}

function compactCapsule(capsule: RecoveryCapsule): RecoveryCapsule {
  const compacted = sanitizeCapsule(capsule);
  compacted.contract.originalGoal = boundText(compacted.contract.originalGoal, 2000);
  compacted.contract.acceptedPlan = boundText(compacted.contract.acceptedPlan, 2000);
  compacted.contract.solReview = boundText(compacted.contract.solReview, 2000);
  compacted.sourceWorker.requestPrompt = boundText(compacted.sourceWorker.requestPrompt, 1000) || undefined;
  compacted.capturedHistory.stdout = boundText(compacted.capturedHistory.stdout, 1000);
  compacted.capturedHistory.stderr = boundText(compacted.capturedHistory.stderr, 1000);
  compacted.capturedHistory.partialResponse = boundText(compacted.capturedHistory.partialResponse, 1000);
  compacted.currentState.gitStatus = boundText(compacted.currentState.gitStatus, 2000);
  compacted.currentState.gitDiff = boundText(compacted.currentState.gitDiff, 2000);
  compacted.currentState.gitDiffStat = boundText(compacted.currentState.gitDiffStat, 1000);
  compacted.currentState.diffCheck = boundText(compacted.currentState.diffCheck, 1000);
  compacted.currentState.filesChanged = boundArray(compacted.currentState.filesChanged, 32, 500);
  compacted.currentState.bridgeVerification = boundVerification(compacted.currentState.bridgeVerification, 8, 500);
  compacted.currentState.incompleteOperations = boundArray(compacted.currentState.incompleteOperations, 8, 500);
  compacted.recoveryDirective.provenComplete = boundArray(compacted.recoveryDirective.provenComplete, 8, 500);
  compacted.recoveryDirective.appearsIncomplete = boundArray(compacted.recoveryDirective.appearsIncomplete, 8, 500);
  compacted.recoveryDirective.knownFailures = boundArray(compacted.recoveryDirective.knownFailures, 8, 500);
  compacted.recoveryDirective.remainingWork = boundArray(compacted.recoveryDirective.remainingWork, 8, 500);
  compacted.recoveryDirective.mustNotRepeatBlindly = boundArray(compacted.recoveryDirective.mustNotRepeatBlindly, 8, 500);
  return compacted;
}

export function buildRecoveryCapsule(input: RecoveryCapsuleInput): RecoveryCapsule {
  return sanitizeCapsule(input);
}

export function serializeRecoveryCapsule(capsule: RecoveryCapsule): string {
  const direct = JSON.stringify(sanitizeCapsule(capsule));
  if (Buffer.byteLength(direct, 'utf8') <= MAX_CAPSULE_BYTES) return direct;

  const compacted = JSON.stringify(compactCapsule(capsule));
  if (Buffer.byteLength(compacted, 'utf8') <= MAX_CAPSULE_BYTES) return compacted;

  const minimal: RecoveryCapsule = {
    schemaVersion: 1,
    generatedAt: boundText(capsule.generatedAt, 500),
    contract: {
      jobId: boundText(capsule.contract.jobId, 500),
      round: capsule.contract.round,
      revision: capsule.contract.revision,
      role: capsule.contract.role,
      originalGoal: boundText(capsule.contract.originalGoal, 500),
      acceptedPlan: boundText(capsule.contract.acceptedPlan, 500),
      solReview: boundText(capsule.contract.solReview, 500),
      baseSha: boundText(capsule.contract.baseSha, 500),
      executionConstraints: boundArray(capsule.contract.executionConstraints, 8, 500),
    },
    sourceWorker: {
      targetId: boundText(capsule.sourceWorker.targetId, 500) || undefined,
      platform: boundText(capsule.sourceWorker.platform, 500),
      model: boundText(capsule.sourceWorker.model, 500),
      sessionId: boundText(capsule.sourceWorker.sessionId, 500) || undefined,
      failureClass: capsule.sourceWorker.failureClass,
      retryAt: boundText(capsule.sourceWorker.retryAt, 500) || undefined,
    },
    capturedHistory: {
      stdout: boundText(capsule.capturedHistory.stdout, 500),
      stderr: boundText(capsule.capturedHistory.stderr, 500),
      partialResponse: boundText(capsule.capturedHistory.partialResponse, 500),
      outputTruncated: capsule.capturedHistory.outputTruncated,
      lastMeaningfulAction: boundText(capsule.capturedHistory.lastMeaningfulAction, 500) || undefined,
    },
    currentState: {
      worktreePath: boundText(capsule.currentState.worktreePath, 1000),
      branch: boundText(capsule.currentState.branch, 500) || undefined,
      baseSha: boundText(capsule.currentState.baseSha, 500),
      headSha: boundText(capsule.currentState.headSha, 500) || undefined,
      inspectionFailed: Boolean(capsule.currentState.inspectionFailed),
      gitStatus: boundText(capsule.currentState.gitStatus, 500),
      gitDiff: boundText(capsule.currentState.gitDiff, 500),
      gitDiffStat: boundText(capsule.currentState.gitDiffStat, 500),
      diffCheck: boundText(capsule.currentState.diffCheck, 500),
      filesChanged: boundArray(capsule.currentState.filesChanged, 16, 500),
      bridgeVerification: boundVerification(capsule.currentState.bridgeVerification, 8, 500),
      incompleteOperations: boundArray(capsule.currentState.incompleteOperations, 8, 500),
    },
    recoveryDirective: {
      provenComplete: boundArray(capsule.recoveryDirective.provenComplete, 8, 500),
      appearsIncomplete: boundArray(capsule.recoveryDirective.appearsIncomplete, 8, 500),
      knownFailures: boundArray(capsule.recoveryDirective.knownFailures, 8, 500),
      remainingWork: boundArray(capsule.recoveryDirective.remainingWork, 8, 500),
      mustNotRepeatBlindly: boundArray(capsule.recoveryDirective.mustNotRepeatBlindly, 8, 500),
      instruction: boundText(capsule.recoveryDirective.instruction, 1000),
    },
  };
  return JSON.stringify(minimal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const RECOVERY_ROLES = new Set(['PLANNER', 'INVESTIGATOR', 'WORKER', 'REVIEWER']);
const RECOVERY_FAILURES = new Set([
  'CLI_MISSING',
  'AUTH_REQUIRED',
  'MODEL_NOT_FOUND',
  'MODEL_UNAVAILABLE',
  'MODEL_DISCOVERY_UNAVAILABLE',
  'MODEL_NOT_SELECTABLE',
  'REASONING_PROFILE_UNSUPPORTED',
  'SESSION_ID_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'PERMISSION_BLOCKED',
  'TIMEOUT',
  'CANCELLED',
  'PROCESS_FAILED',
  'OUTPUT_INVALID',
  'INTERRUPTED',
  'UNKNOWN',
]);

function hasString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOwnerApproval(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.approved === 'boolean' &&
    (value.approvedBy === undefined || hasString(value.approvedBy)) &&
    (value.approvedAt === undefined || hasString(value.approvedAt)) &&
    (value.notes === undefined || hasString(value.notes))
  );
}

function isRecoveryCapsuleShape(value: unknown): value is RecoveryCapsuleInput & { schemaVersion: 1; generatedAt: string } {
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasString(value.generatedAt)) return false;
  const contract = value.contract;
  const sourceWorker = value.sourceWorker;
  const capturedHistory = value.capturedHistory;
  const currentState = value.currentState;
  const recoveryDirective = value.recoveryDirective;
  if (!isRecord(contract) || !isRecord(sourceWorker) || !isRecord(capturedHistory) || !isRecord(currentState) || !isRecord(recoveryDirective)) {
    return false;
  }

  const approvalValid = contract.ownerApproval === undefined || isOwnerApproval(contract.ownerApproval);
  const failureValid = sourceWorker.failureClass === undefined || RECOVERY_FAILURES.has(String(sourceWorker.failureClass));
  const toolSummaryValid =
    sourceWorker.reasoning === undefined || hasString(sourceWorker.reasoning);
  const capturedToolSummaryValid =
    capturedHistory.toolSummary === undefined ||
    (isRecord(capturedHistory.toolSummary) && Object.values(capturedHistory.toolSummary).every((item) => typeof item === 'number' && Number.isFinite(item)));
  const verificationValid =
    isRecord(currentState.bridgeVerification) &&
    Object.values(currentState.bridgeVerification).every((item) => typeof item === 'string');

  return (
    hasString(contract.jobId) &&
    Number.isInteger(contract.round) &&
    Number.isInteger(contract.revision) &&
    hasString(contract.role) &&
    RECOVERY_ROLES.has(contract.role) &&
    hasString(contract.originalGoal) &&
    hasString(contract.acceptedPlan) &&
    hasString(contract.solReview) &&
    approvalValid &&
    hasString(contract.baseSha) &&
    hasStringArray(contract.executionConstraints) &&
    (sourceWorker.targetId === undefined || hasString(sourceWorker.targetId)) &&
    hasString(sourceWorker.platform) &&
    hasString(sourceWorker.model) &&
    toolSummaryValid &&
    (sourceWorker.sessionId === undefined || hasString(sourceWorker.sessionId)) &&
    (sourceWorker.requestPrompt === undefined || hasString(sourceWorker.requestPrompt)) &&
    (sourceWorker.startedAt === undefined || hasString(sourceWorker.startedAt)) &&
    (sourceWorker.endedAt === undefined || hasString(sourceWorker.endedAt)) &&
    failureValid &&
    (sourceWorker.retryAt === undefined || hasString(sourceWorker.retryAt)) &&
    hasString(capturedHistory.stdout) &&
    hasString(capturedHistory.stderr) &&
    hasString(capturedHistory.partialResponse) &&
    typeof capturedHistory.outputTruncated === 'boolean' &&
    capturedToolSummaryValid &&
    (capturedHistory.sessionId === undefined || hasString(capturedHistory.sessionId)) &&
    (capturedHistory.lastMeaningfulAction === undefined || hasString(capturedHistory.lastMeaningfulAction)) &&
    hasString(currentState.worktreePath) &&
    (currentState.branch === undefined || hasString(currentState.branch)) &&
    hasString(currentState.baseSha) &&
    (currentState.headSha === undefined || hasString(currentState.headSha)) &&
    (currentState.inspectionFailed === undefined || typeof currentState.inspectionFailed === 'boolean') &&
    hasString(currentState.gitStatus) &&
    hasString(currentState.gitDiff) &&
    hasString(currentState.gitDiffStat) &&
    hasString(currentState.diffCheck) &&
    hasStringArray(currentState.filesChanged) &&
    verificationValid &&
    hasStringArray(currentState.incompleteOperations) &&
    hasStringArray(recoveryDirective.provenComplete) &&
    hasStringArray(recoveryDirective.appearsIncomplete) &&
    hasStringArray(recoveryDirective.knownFailures) &&
    hasStringArray(recoveryDirective.remainingWork) &&
    hasStringArray(recoveryDirective.mustNotRepeatBlindly) &&
    hasString(recoveryDirective.instruction)
  );
}

export function parseRecoveryCapsule(raw: string, expectedJobId?: string): RecoveryCapsule | undefined {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CAPSULE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecoveryCapsuleShape(parsed)) return undefined;
  if (expectedJobId && parsed.contract.jobId !== expectedJobId) return undefined;
  const sanitized = sanitizeCapsule(parsed);
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_CAPSULE_BYTES) return undefined;
  return sanitized;
}

async function readGit(worktreePath: string, args: string[], maxBytes = MAX_TEXT_BYTES): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', worktreePath, ...args], {
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
    return boundText(`${stdout}${stderr ? `\n${stderr}` : ''}`, maxBytes);
  } catch (err: any) {
    return boundText(
      `GIT_INSPECTION_ERROR: ${err.stdout || ''}${err.stderr ? `\n${err.stderr}` : ''}${err.message || err}`,
      maxBytes
    );
  }
}

export async function captureWorktreeState(worktreePath: string, baseSha: string): Promise<RecoveryCurrentState> {
  const [branch, headSha, gitStatus, gitDiff, gitDiffStat, diffCheck] = await Promise.all([
    readGit(worktreePath, ['symbolic-ref', '--short', 'HEAD'], 1000),
    readGit(worktreePath, ['rev-parse', 'HEAD'], 500),
    readGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']),
    readGit(worktreePath, ['diff', baseSha]),
    readGit(worktreePath, ['diff', '--stat', baseSha]),
    readGit(worktreePath, ['diff', '--check']),
  ]);
  const statusLines = gitStatus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diffCheckResult = diffCheck.includes('error:') || diffCheck.includes('fatal:') ? diffCheck : 'PASS';

  return {
    worktreePath: boundText(worktreePath, 2000),
    branch: branch || undefined,
    baseSha: boundText(baseSha, 500),
    headSha: headSha || undefined,
    gitStatus,
    gitDiff,
    gitDiffStat,
    diffCheck: diffCheckResult,
    filesChanged: boundArray(statusLines),
    bridgeVerification: {
      build: 'not-run',
      tests: 'not-run',
    },
    inspectionFailed: [branch, headSha, gitStatus, gitDiff, gitDiffStat, diffCheck].some((value) =>
      value.startsWith('GIT_INSPECTION_ERROR:')
    ),
    incompleteOperations: [],
  };
}

export const RECOVERY_CAPSULE_MAX_BYTES = MAX_CAPSULE_BYTES;
