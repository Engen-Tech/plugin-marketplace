interface ShutdownChildren {
  abortAll(): Promise<void>;
}

interface ShutdownLocks {
  releaseAll(): Promise<void>;
}

interface ShutdownGuards {
  shutdown(): void;
}

interface ShutdownPreflight {
  clear(): void;
}

export class HatchShutdownCoordinator {
  readonly #children: ShutdownChildren;
  readonly #locks: ShutdownLocks;
  readonly #guards: ShutdownGuards;
  readonly #preflight: ShutdownPreflight;
  readonly #releaseInstance: () => void;
  #promise?: Promise<void>;

  constructor(options: {
    children: ShutdownChildren;
    locks: ShutdownLocks;
    guards: ShutdownGuards;
    preflight: ShutdownPreflight;
    releaseInstance: () => void;
  }) {
    this.#children = options.children;
    this.#locks = options.locks;
    this.#guards = options.guards;
    this.#preflight = options.preflight;
    this.#releaseInstance = options.releaseInstance;
  }

  shutdown(): Promise<void> {
    if (this.#promise) return this.#promise;
    this.#guards.shutdown();
    this.#preflight.clear();
    this.#promise = (async () => {
      try {
        await this.#children.abortAll();
      } finally {
        try {
          await this.#locks.releaseAll();
        } finally {
          this.#releaseInstance();
        }
      }
    })();
    return this.#promise;
  }
}
