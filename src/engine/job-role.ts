import { JobIntent, WorkerRole } from '../types.js';

export function roleForJob(intent: JobIntent, explicitRole?: WorkerRole | string): WorkerRole {
  if (explicitRole) {
    if (explicitRole === 'INVESTIGATOR' || explicitRole === 'WORKER' || explicitRole === 'REVIEWER') {
      return explicitRole as WorkerRole;
    }
    throw new Error(`INVALID_ROLE: Role "${explicitRole}" is not a selectable Worker Bridge role. Expected INVESTIGATOR, WORKER, or REVIEWER.`);
  }

  switch (intent) {
    case 'plan':
    case 'design':
    case 'investigate':
      return 'INVESTIGATOR';
    case 'implement':
    case 'fix':
      return 'WORKER';
    case 'review':
    case 'audit':
      return 'REVIEWER';
    default:
      throw new Error(`INVALID_INTENT: Intent "${intent}" is not recognized.`);
  }
}
