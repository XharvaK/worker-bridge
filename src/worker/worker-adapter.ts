import {
  DiscoveredModel,
  OperationalFailureClass,
  QuotaProbeResult,
  WorkerInvocationRequest,
  WorkerRoundResult,
} from '../types.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';

export interface WorkerPlatformInfo {
  platformId: string;
  displayName: string;
  installed: boolean;
  version?: string;
  executablePath: string;
  error?: string;
}

export interface WorkerAdapter {
  readonly platformId: string;
  readonly supportsCrossModelSessionContinuation?: boolean;

  /**
   * Inspect the platform's local installation and environment.
   */
  inspectEnvironment(): Promise<WorkerPlatformInfo>;

  /**
   * Discover available models from the platform's local CLI.
   */
  discoverModels(refresh?: boolean): Promise<DiscoveredModel[]>;

  /**
   * Resolve reasoning profile (e.g. variant or effort) for the given model.
   */
  resolveReasoningProfile(
    modelId: string,
    requestedStrategy?: 'highest-supported' | 'explicit',
    explicitValue?: string
  ): Promise<string | undefined>;

  /**
   * Probe quota state if authoritatively available.
   */
  probeQuota(modelId?: string): Promise<QuotaProbeResult>;

  /**
   * Invoke the worker for a round.
   */
  invokeWorker(request: WorkerInvocationRequest): Promise<WorkerRoundResult>;

  /**
   * Cancel an active worker process for a given jobId.
   */
  cancel(jobId: string): Promise<boolean>;
}

export interface OperationalFailureAnalysis {
  failureClass: OperationalFailureClass;
  retryAt?: string;
  rawEvidence?: string;
}

const MAX_FAILURE_EVIDENCE = 4000;

function boundEvidence(value: string): string {
  const sanitized = sanitizeSecrets(value.trim());
  if (sanitized.length <= MAX_FAILURE_EVIDENCE) return sanitized;
  return `${sanitized.slice(0, 1000)}\n...[truncated]...\n${sanitized.slice(-MAX_FAILURE_EVIDENCE + 1018)}`.slice(
    0,
    MAX_FAILURE_EVIDENCE
  );
}

function parseAuthoritativeRetryAt(text: string, observedAt: string): string | undefined {
  const absolute = text.match(
    /(?:reset(?:_at|[ _-]+at)?|retry(?:_at|[ _-]+at)?|reset[ _-]+timestamp)\s*[:=]\s*((?:\d{4}-\d{2}-\d{2}T|\d{4}-\d{2}-\d{2}\s)\S+)/i
  );
  if (absolute) {
    const parsed = Date.parse(absolute[1]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const retryAfter = text.match(
    /retry[ _-]*after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i
  );
  const tryAgain = text.match(
    /try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i
  );
  const duration = retryAfter || tryAgain;
  if (!duration) return undefined;

  const amount = Number(duration[1]);
  const unit = (duration[2] || 'seconds').toLowerCase();
  const multiplier = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(amount) || Number.isNaN(observedMs)) return undefined;
  return new Date(observedMs + amount * multiplier * 1000).toISOString();
}

function classifyFailure(exitCode: number, stdout: string, stderr: string, timedOut: boolean): OperationalFailureClass {
  if (timedOut) return 'TIMEOUT';

  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (
    combined.includes('quota') ||
    combined.includes('exceeded your current quota') ||
    combined.includes('insufficient_quota') ||
    combined.includes('credits exhausted') ||
    combined.includes('out of credits') ||
    combined.includes('billing')
  ) {
    return 'QUOTA_EXHAUSTED';
  }
  if (
    combined.includes('rate limit') ||
    combined.includes('too many requests') ||
    combined.includes('429') ||
    combined.includes('resource_exhausted') ||
    combined.includes('overloaded')
  ) {
    return 'RATE_LIMITED';
  }
  if (
    combined.includes('not authenticated') ||
    combined.includes('unauthorized') ||
    combined.includes('401') ||
    combined.includes('auth error') ||
    combined.includes('api key') ||
    combined.includes('login required')
  ) {
    return 'AUTH_REQUIRED';
  }
  if (
    combined.includes('model not found') ||
    combined.includes('unknown model') ||
    combined.includes('does not exist') ||
    combined.includes('404')
  ) {
    return 'MODEL_NOT_FOUND';
  }
  if (combined.includes('permission denied') || combined.includes('access denied') || combined.includes('eacces')) {
    return 'PERMISSION_BLOCKED';
  }
  if (
    combined.includes('500') ||
    combined.includes('502') ||
    combined.includes('503') ||
    combined.includes('service unavailable') ||
    combined.includes('bad gateway')
  ) {
    return 'MODEL_UNAVAILABLE';
  }
  if (exitCode !== 0) return 'PROCESS_FAILED';
  return 'UNKNOWN';
}

export function analyzeOperationalError(
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut = false,
  observedAt = new Date().toISOString()
): OperationalFailureAnalysis {
  const evidence = boundEvidence(`${stdout}\n${stderr}`);
  return {
    failureClass: classifyFailure(exitCode, stdout, stderr, timedOut),
    retryAt: parseAuthoritativeRetryAt(`${stdout}\n${stderr}`, observedAt),
    rawEvidence: evidence || undefined,
  };
}

export function classifyOperationalError(
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut = false
): OperationalFailureClass {
  return analyzeOperationalError(exitCode, stdout, stderr, timedOut).failureClass;
}
