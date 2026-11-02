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

interface ShutdownRuns {
  abortAll(reason: "shutdown"): void;
  settled(timeoutMs: number): Promise<void>;
}

export const RUN_SETTLE_TIMEOUT_MS = 5_000;

// The timer is ref'd on purpose. The wait is bounded, and the shutdown steps after it
// (locks.releaseAll, releaseInstance) must run even when a run never settles: an unref'd timer
// lets Node exit before the bound fires. The finally clears it, so a run that settles first
// adds no exit delay.
function bounded(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export class HatchShutdownCoordinator {
  readonly #children: ShutdownChildren;
  readonly #locks: ShutdownLocks;
  readonly #guards: ShutdownGuards;
  readonly #preflight: ShutdownPreflight;
  readonly #runs?: ShutdownRuns;
  readonly #runSettleTimeoutMs: number;
  readonly #releaseInstance: () => void;
  #promise?: Promise<void>;

  constructor(options: {
    children: ShutdownChildren;
    locks: ShutdownLocks;
    guards: ShutdownGuards;
    preflight: ShutdownPreflight;
    runs?: ShutdownRuns;
    runSettleTimeoutMs?: number;
    releaseInstance: () => void;
  }) {
    this.#children = options.children;
    this.#locks = options.locks;
    this.#guards = options.guards;
    this.#preflight = options.preflight;
    this.#runs = options.runs;
    this.#runSettleTimeoutMs = options.runSettleTimeoutMs ?? RUN_SETTLE_TIMEOUT_MS;
    this.#releaseInstance = options.releaseInstance;
  }

  shutdown(): Promise<void> {
    if (this.#promise) return this.#promise;
    this.#guards.shutdown();
    this.#preflight.clear();
    // A run's own signal goes first so its children see the abort before they are killed.
    try {
      this.#runs?.abortAll("shutdown");
    } catch {
      // Children and locks are still released below.
    }
    this.#promise = (async () => {
      try {
        await this.#children.abortAll();
      } finally {
        try {
          // Each runner's own finally releases its lease; a bounded wait lets it, without letting
          // a runner that ignores its signal hold the session open.
          if (this.#runs) {
            await bounded(
              this.#runs.settled(this.#runSettleTimeoutMs).catch(() => {}),
              this.#runSettleTimeoutMs,
            );
          }
        } finally {
          try {
            await this.#locks.releaseAll();
          } finally {
            this.#releaseInstance();
          }
        }
      }
    })();
    return this.#promise;
  }
}
