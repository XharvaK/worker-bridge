import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigManager } from '../../src/config.js';
import { TargetAvailabilityLedger } from '../../src/engine/target-availability-ledger.js';
import { DurableService } from '../../src/service/durable-service.js';
import { getServicePipePath } from '../../src/service/ipc-protocol.js';
import { JobManager } from '../../src/service/job-manager.js';
import { AdapterRegistry } from '../../src/worker/adapter-registry.js';
import { TargetAvailabilityRecord, TargetAvailabilityState } from '../../src/types.js';

function makeService(availabilityPath: string, root: string): DurableService {
  const configManager = new ConfigManager({
    mailboxRepoPath: path.join(root, 'mailbox'),
    workerRootDir: path.join(root, 'workers'),
    pushWorkerBranches: false,
    notificationsEnabled: false,
    allowedProjects: {
      durable: { path: path.join(root, 'repo'), allowed: true, defaultBranch: 'master', allowPushWorkerBranch: false },
    },
    selectionPolicy: {
      targets: {
        target_a: {
          targetId: 'target_a',
          platformId: 'mock-a',
          modelId: 'mock-a-model',
          displayName: 'Mock A',
          reasoning: { strategy: 'highest-supported' },
        },
        target_b: {
          targetId: 'target_b',
          platformId: 'mock-b',
          modelId: 'mock-b-model',
          displayName: 'Mock B',
          reasoning: { strategy: 'highest-supported' },
        },
      },
      roleRankings: {
        PLANNER: ['target_a', 'target_b'],
        INVESTIGATOR: ['target_a', 'target_b'],
        WORKER: ['target_a', 'target_b'],
        REVIEWER: ['target_a', 'target_b'],
      },
      allowFallbackByDefault: false,
      maxFallbackAttempts: 2,
    },
  });
  return new DurableService({
    pipePath: getServicePipePath(`qual-${Math.random().toString(36).slice(2)}`),
    configManager,
    availabilityLedger: new TargetAvailabilityLedger(availabilityPath),
    jobManager: new JobManager({ trustedRoots: [root], storagePath: path.join(root, 'ipc-jobs.json') }),
    adapterRegistry: new AdapterRegistry(),
    trustedRoots: [root],
  });
}

function seedAvailability(
  availabilityPath: string,
  record: Partial<TargetAvailabilityRecord> & { targetId: string; state: TargetAvailabilityState }
): void {
  fs.mkdirSync(path.dirname(availabilityPath), { recursive: true });
  fs.writeFileSync(
    availabilityPath,
    JSON.stringify(
      {
        version: 1,
        targets: {
          [record.targetId]: {
            platformId: 'mock-a',
            modelId: 'mock-a-model',
            observedAt: new Date().toISOString(),
            source: 'test',
            ...record,
          },
        },
      },
      null,
      2
    )
  );
}

describe('list_targets qualification truth', () => {
  it('reports UNKNOWN for a target with no availability record', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    try {
      const service = makeService(path.join(root, 'availability.json'), root);
      const targets = service.listTargets();
      const targetA = targets.targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('UNKNOWN');
      expect(targetA.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps AVAILABLE evidence to KNOWN_AVAILABLE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, { targetId: 'target_a', state: 'AVAILABLE' });
      const service = makeService(availabilityPath, root);
      const targetA = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('KNOWN_AVAILABLE');
      expect(targetA.available).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps LOW evidence to KNOWN_AVAILABLE (degraded but positive)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, { targetId: 'target_a', state: 'LOW' });
      const service = makeService(availabilityPath, root);
      const targetA = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('KNOWN_AVAILABLE');
      expect(targetA.available).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps EXHAUSTED evidence to KNOWN_UNAVAILABLE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, {
        targetId: 'target_a',
        state: 'EXHAUSTED',
        failureClass: 'QUOTA_EXHAUSTED',
        source: 'provider_error',
      });
      const service = makeService(availabilityPath, root);
      const targetA = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('KNOWN_UNAVAILABLE');
      expect(targetA.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps an active COOLDOWN to KNOWN_UNAVAILABLE until it expires', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, {
        targetId: 'target_a',
        state: 'COOLDOWN',
        failureClass: 'AUTOMATION_SEAM_UNAVAILABLE',
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
        source: 'provider_error',
      });
      const service = makeService(availabilityPath, root);
      const active = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(active.qualification).toBe('KNOWN_UNAVAILABLE');
      expect(active.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not claim KNOWN_AVAILABLE after cooldown expiry: expired cooldown is UNKNOWN until positive evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, {
        targetId: 'target_a',
        state: 'COOLDOWN',
        failureClass: 'AUTOMATION_SEAM_UNAVAILABLE',
        retryAt: new Date(Date.now() - 60_000).toISOString(),
        source: 'provider_error',
      });
      const service = makeService(availabilityPath, root);
      const expired = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(expired.qualification).toBe('UNKNOWN');
      expect(expired.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps an ELIGIBLE_TO_RETRY record to UNKNOWN', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, { targetId: 'target_a', state: 'ELIGIBLE_TO_RETRY' });
      const service = makeService(availabilityPath, root);
      const targetA = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('UNKNOWN');
      expect(targetA.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps an UNKNOWN state record to UNKNOWN', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    try {
      seedAvailability(availabilityPath, { targetId: 'target_a', state: 'UNKNOWN' });
      const service = makeService(availabilityPath, root);
      const targetA = service.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(targetA.qualification).toBe('UNKNOWN');
      expect(targetA.available).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks the Freebuff lifecycle: UNKNOWN → KNOWN_UNAVAILABLE → UNKNOWN → KNOWN_AVAILABLE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-truth-'));
    const availabilityPath = path.join(root, 'availability.json');
    const target = {
      targetId: 'target_a',
      platformId: 'mock-a',
      modelId: 'mock-a-model',
      displayName: 'Mock A',
      reasoning: { strategy: 'highest-supported' },
    };
    try {
      const fresh = makeService(availabilityPath, root);
      const initial = fresh.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(initial.qualification).toBe('UNKNOWN');

      const ledger = new TargetAvailabilityLedger(availabilityPath);
      ledger.recordFailure(
        target,
        'AUTOMATION_SEAM_UNAVAILABLE',
        new Date().toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(),
        'retry-after: 3600'
      );
      const cooling = makeService(availabilityPath, root);
      const unavailable = cooling.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(unavailable.qualification).toBe('KNOWN_UNAVAILABLE');
      expect(unavailable.available).toBe(false);

      seedAvailability(availabilityPath, {
        targetId: 'target_a',
        state: 'COOLDOWN',
        failureClass: 'AUTOMATION_SEAM_UNAVAILABLE',
        retryAt: new Date(Date.now() - 60_000).toISOString(),
        source: 'provider_error',
      });
      const expiredLedger = new TargetAvailabilityLedger(availabilityPath);
      const afterExpiry = makeService(availabilityPath, root);
      const eligible = afterExpiry.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(eligible.qualification).toBe('UNKNOWN');
      expect(eligible.available).toBe(false);

      expiredLedger.recordSuccess('target_a', target);
      const positive = makeService(availabilityPath, root);
      const available = positive.listTargets().targets.find((t) => t.targetId === 'target_a')!;
      expect(available.qualification).toBe('KNOWN_AVAILABLE');
      expect(available.available).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});