import { randomUUID } from "node:crypto";

export type LifecycleRole =
  | "phase0-probe"
  | "provider-preflight"
  | "delivery"
  | "host-check"
  | "managed-process"
  | "env-server"
  | "acceptance-gate"
  | "safety-gate"
  | "visual-gate"
  | "build-worker"
  | "doc-gardner"
  | "kaizen";

export interface LifecycleResource {
  abort(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface LifecycleRegistration {
  id?: string;
  role: LifecycleRole;
  cwd: string;
  parentId?: string;
  label?: string;
  resource: LifecycleResource;
}

export interface LifecycleSnapshot {
  id: string;
  role: LifecycleRole;
  cwd: string;
  parentId?: string;
  label?: string;
  startedAt: number;
}

interface LifecycleRecord extends LifecycleSnapshot {
  resource: LifecycleResource;
}

export class LifecycleRegistry {
  readonly #records = new Map<string, LifecycleRecord>();
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  register(registration: LifecycleRegistration): string {
    if (this.#shuttingDown) throw new Error("Hatch lifecycle registry is shutting down");
    const id = registration.id ?? randomUUID();
    if (this.#records.has(id)) throw new Error(`Hatch lifecycle id already active: ${id}`);
    if (registration.parentId && !this.#records.has(registration.parentId)) {
      throw new Error(`Hatch lifecycle parent is not active: ${registration.parentId}`);
    }
    this.#records.set(id, {
      id,
      role: registration.role,
      cwd: registration.cwd,
      parentId: registration.parentId,
      label: registration.label,
      startedAt: Date.now(),
      resource: registration.resource,
    });
    return id;
  }

  forget(id: string): boolean {
    if ([...this.#records.values()].some((record) => record.parentId === id)) {
      throw new Error(`Hatch lifecycle still owns active children: ${id}`);
    }
    return this.#records.delete(id);
  }

  snapshot(): LifecycleSnapshot[] {
    return [...this.#records.values()]
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map(({ resource: _resource, ...record }) => record);
  }

  get size(): number {
    return this.#records.size;
  }

  async stop(id: string): Promise<void> {
    const root = this.#records.get(id);
    if (!root) return;
    const belongsTo = (record: LifecycleRecord): boolean => {
      let current: LifecycleRecord | undefined = record;
      while (current) {
        if (current.id === id) return true;
        current = current.parentId ? this.#records.get(current.parentId) : undefined;
      }
      return false;
    };
    const depth = (record: LifecycleRecord): number => {
      let value = 0;
      let parentId = record.parentId;
      while (parentId) {
        value += 1;
        parentId = this.#records.get(parentId)?.parentId;
      }
      return value;
    };
    const records = [...this.#records.values()]
      .filter(belongsTo)
      .sort((left, right) => depth(right) - depth(left) || right.startedAt - left.startedAt);
    await Promise.allSettled(records.map((record) => Promise.resolve().then(() => record.resource.abort())));
    await Promise.allSettled(records.map((record) => Promise.resolve().then(() => record.resource.dispose())));
    for (const record of records) this.#records.delete(record.id);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = (async () => {
      const depth = (record: LifecycleRecord): number => {
        let value = 0;
        let parentId = record.parentId;
        while (parentId) {
          value += 1;
          parentId = this.#records.get(parentId)?.parentId;
        }
        return value;
      };
      const records = [...this.#records.values()].sort(
        (left, right) => depth(right) - depth(left) || right.startedAt - left.startedAt,
      );
      await Promise.allSettled(
        records.map((record) => Promise.resolve().then(() => record.resource.abort())),
      );
      await Promise.allSettled(
        records.map((record) => Promise.resolve().then(() => record.resource.dispose())),
      );
      this.#records.clear();
    })();
    return this.#shutdownPromise;
  }
}
