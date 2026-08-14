import { WorkerAdapter } from './worker-adapter.js';

export class AdapterRegistry {
  private adapters: Map<string, WorkerAdapter> = new Map();

  register(adapter: WorkerAdapter): void {
    this.adapters.set(adapter.platformId.toLowerCase(), adapter);
  }

  get(platformId: string): WorkerAdapter | undefined {
    return this.adapters.get(platformId.toLowerCase());
  }

  has(platformId: string): boolean {
    return this.adapters.has(platformId.toLowerCase());
  }

  listPlatforms(): string[] {
    return Array.from(this.adapters.keys());
  }

  getAll(): WorkerAdapter[] {
    return Array.from(this.adapters.values());
  }
}
