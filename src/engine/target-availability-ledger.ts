import * as fs from 'node:fs';
import * as path from 'node:path';
import { USER_BRIDGE_DIR } from '../config.js';
import {
  OperationalFailureClass,
  TargetAvailabilityRecord,
  TargetAvailabilityState,
  WorkerTargetConfig,
} from '../types.js';
import { sanitizeSecrets } from '../utils/sanitizer.js';

export interface TargetAvailabilityStore {
  get(targetId: string, now?: Date): TargetAvailabilityRecord | null;
  isEligible(targetId: string, now?: Date): boolean;
  recordFailure(
    target: WorkerTargetConfig,
    failureClass: OperationalFailureClass,
    observedAt: string,
    retryAt?: string,
    rawEvidence?: string,
    source?: string
  ): TargetAvailabilityRecord;
  recordSuccess(targetId: string, target?: WorkerTargetConfig): void;
}

interface AvailabilityData {
  version: number;
  targets: Record<string, TargetAvailabilityRecord>;
}

const MAX_RAW_EVIDENCE = 4000;

function boundEvidence(value?: string): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeSecrets(value);
  if (sanitized.length <= MAX_RAW_EVIDENCE) return sanitized;
  return `${sanitized.slice(0, 1000)}\n...[truncated]...\n${sanitized.slice(-MAX_RAW_EVIDENCE + 1020)}`.slice(
    0,
    MAX_RAW_EVIDENCE
  );
}

export class TargetAvailabilityLedger implements TargetAvailabilityStore {
  private readonly ledgerPath: string;
  private data: AvailabilityData = { version: 1, targets: {} };

  constructor(customPath?: string) {
    this.ledgerPath = customPath ? path.resolve(customPath) : path.join(USER_BRIDGE_DIR, 'target-availability.json');
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.ledgerPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Partial<AvailabilityData>;
      this.data = {
        version: parsed.version || 1,
        targets: parsed.targets || {},
      };
    } catch {
      this.data = { version: 1, targets: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.ledgerPath);
    fs.mkdirSync(dir, { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.ledgerPath);
  }

  get(targetId: string, now = new Date()): TargetAvailabilityRecord | null {
    const record = this.data.targets[targetId];
    if (!record) return null;

    if (record.state === 'COOLDOWN' && record.retryAt && now.getTime() >= Date.parse(record.retryAt)) {
      record.state = 'ELIGIBLE_TO_RETRY';
      this.save();
    }

    return { ...record };
  }

  isEligible(targetId: string, now = new Date()): boolean {
    const record = this.get(targetId, now);
    if (!record) return true;
    return (
      record.state === 'AVAILABLE' ||
      record.state === 'LOW' ||
      record.state === 'ELIGIBLE_TO_RETRY' ||
      record.state === 'UNKNOWN'
    );
  }

  recordFailure(
    target: WorkerTargetConfig,
    failureClass: OperationalFailureClass,
    observedAt: string,
    retryAt?: string,
    rawEvidence?: string,
    source = 'provider_error'
  ): TargetAvailabilityRecord {
    const state: TargetAvailabilityState = retryAt ? 'COOLDOWN' : 'EXHAUSTED';
    const record: TargetAvailabilityRecord = {
      targetId: target.targetId,
      platformId: target.platformId,
      modelId: target.modelId,
      state,
      failureClass,
      observedAt,
      retryAt,
      rawEvidence: boundEvidence(rawEvidence),
      source,
    };
    this.data.targets[target.targetId] = record;
    this.save();
    return { ...record };
  }

  recordSuccess(targetId: string, target?: WorkerTargetConfig): void {
    const existing = this.data.targets[targetId];
    if (!existing || existing.state !== 'AVAILABLE') {
      this.data.targets[targetId] = {
        targetId,
        platformId: target?.platformId || existing?.platformId || '',
        modelId: target?.modelId || existing?.modelId || '',
        state: 'AVAILABLE',
        observedAt: new Date().toISOString(),
        source: 'successful_execution',
      };
      this.save();
    }
  }
}

export class InMemoryTargetAvailabilityStore implements TargetAvailabilityStore {
  private readonly records = new Map<string, TargetAvailabilityRecord>();

  get(targetId: string, now = new Date()): TargetAvailabilityRecord | null {
    const record = this.records.get(targetId);
    if (!record) return null;
    if (record.state === 'COOLDOWN' && record.retryAt && now.getTime() >= Date.parse(record.retryAt)) {
      record.state = 'ELIGIBLE_TO_RETRY';
    }
    return { ...record };
  }

  isEligible(targetId: string, now = new Date()): boolean {
    const record = this.get(targetId, now);
    return !record || ['AVAILABLE', 'LOW', 'ELIGIBLE_TO_RETRY', 'UNKNOWN'].includes(record.state);
  }

  recordFailure(
    target: WorkerTargetConfig,
    failureClass: OperationalFailureClass,
    observedAt: string,
    retryAt?: string,
    rawEvidence?: string,
    source = 'provider_error'
  ): TargetAvailabilityRecord {
    const record: TargetAvailabilityRecord = {
      targetId: target.targetId,
      platformId: target.platformId,
      modelId: target.modelId,
      state: retryAt ? 'COOLDOWN' : 'EXHAUSTED',
      failureClass,
      observedAt,
      retryAt,
      rawEvidence: boundEvidence(rawEvidence),
      source,
    };
    this.records.set(target.targetId, record);
    return { ...record };
  }

  recordSuccess(targetId: string, target?: WorkerTargetConfig): void {
    const existing = this.records.get(targetId);
    this.records.set(targetId, {
      targetId,
      platformId: target?.platformId || existing?.platformId || '',
      modelId: target?.modelId || existing?.modelId || '',
      state: 'AVAILABLE',
      observedAt: new Date().toISOString(),
      source: 'successful_execution',
    });
  }
}
