import { JobIntent, WorkerRole } from '../types.js';

export function roleForJob(intent: JobIntent, explicitRole?: WorkerRole): WorkerRole {
  if (explicitRole) return explicitRole;

  switch (intent) {
    case 'plan':
    case 'design':
      return 'PLANNER';
    case 'investigate':
      return 'INVESTIGATOR';
    case 'implement':
    case 'fix':
      return 'WORKER';
    case 'review':
    case 'audit':
      return 'REVIEWER';
  }
}
