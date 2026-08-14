import { JobSpec, JobStatus } from '../types.js';

const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SHA_REGEX = /^[a-fA-F0-9]{7,40}$/;
const VALID_PHASES = new Set(['PLAN', 'IMPLEMENT', 'CANCEL']);

export function parseJobSpec(rawContent: string): { valid: boolean; spec?: JobSpec; error?: string } {
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

  if (parsed.schemaVersion !== 1) {
    return { valid: false, error: `Unsupported schemaVersion: ${parsed.schemaVersion}. Expected 1.` };
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

  if (!parsed.requestedPhase || !VALID_PHASES.has(parsed.requestedPhase)) {
    return { valid: false, error: `Invalid requestedPhase: "${parsed.requestedPhase}". Expected PLAN, IMPLEMENT, or CANCEL.` };
  }

  if (typeof parsed.revision !== 'number' || !Number.isInteger(parsed.revision) || parsed.revision < 1) {
    return { valid: false, error: `Invalid revision: ${parsed.revision}. Must be an integer >= 1.` };
  }

  const spec: JobSpec = {
    schemaVersion: 1,
    jobId: parsed.jobId,
    projectId: parsed.projectId,
    baseSha: parsed.baseSha.trim(),
    requestedPhase: parsed.requestedPhase,
    revision: parsed.revision,
    createdAt: parsed.createdAt || new Date().toISOString(),
    targetBranch: parsed.targetBranch,
    timeoutSeconds: typeof parsed.timeoutSeconds === 'number' && parsed.timeoutSeconds > 0 ? parsed.timeoutSeconds : 900,
  };

  return { valid: true, spec };
}

export function formatStatusJson(status: JobStatus): string {
  return JSON.stringify(status, null, 2);
}
