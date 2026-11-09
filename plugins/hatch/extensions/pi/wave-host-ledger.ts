import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  return stdout;
}

const LISTING_RACE = /failed to read '\.git\/worktrees\/[^']*\/locked'/;
const LISTING_RETRY_MS = [50, 150];

/**
 * `git worktree list` dies when a wave-mate's worktree entry loses its `locked`
 * file between git's existence check and its read. Retry only that listing and
 * only that error, at most three attempts, then rethrow the last error unchanged.
 */
async function worktreeList(cwd: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await git(cwd, ["worktree", "list", "--porcelain"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (attempt >= LISTING_RETRY_MS.length || !LISTING_RACE.test(stderr)) throw error;
      await new Promise((resolve) => setTimeout(resolve, LISTING_RETRY_MS[attempt]));
    }
  }
}

/** Split a `git worktree list --porcelain` listing into its per-worktree blocks. */
function porcelainBlocks(porcelain: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * A canonical string of everything the host may author for one wave-mate item:
 * its `refs/heads/hatch/<binder>/item-<item>` branch, its `refs/hatch/<binder>/
 * item-<item>` namespace, and every worktree block checked out on that branch.
 *
 * `for-each-ref` matches a pattern literally or up to a slash, so `item-x` never
 * sweeps in `item-xy`; the worktree filter matches the whole `branch` line, so a
 * longer id's checkout is never included either.
 */
export async function captureMateSurface(
  repository: string,
  binder: string,
  item: string,
): Promise<string> {
  const branchRef = `refs/heads/hatch/${binder}/item-${item}`;
  const namespace = `refs/hatch/${binder}/item-${item}`;
  const [refs, registry] = await Promise.all([
    git(repository, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)",
      branchRef,
      namespace,
    ]),
    worktreeList(repository),
  ]);
  const blocks = porcelainBlocks(registry).filter((block) =>
    block.split("\n").some((line) => line === `branch ${branchRef}`),
  );
  return [`refs\0${refs}`, ...blocks].join("\0");
}

interface Waiter {
  resolve: () => void;
}

/**
 * Tracks which items have a host phase in flight for one wave, and the surface
 * each host phase last authored for its item.
 *
 * The host writes a wave-mate's branch, built/failed refs, and worktree while
 * other items are still building. A worker must not be blamed for those writes,
 * so the host records its own surface at the end of every phase, a quiesce keeps
 * snapshots from racing a live phase, and attestation accepts a mate change only
 * when it matches the host's record. A worker changing a mate's refs or HEAD
 * outside a host phase matches no record and is still caught.
 */
export class WaveHostLedger {
  readonly #repository: string;
  readonly #binder: string;
  readonly #busy = new Map<string, number>();
  readonly #records = new Map<string, string>();
  #quiesceRequested = 0;
  #quiesceTail: Promise<void> = Promise.resolve();
  #busyWaiters: Waiter[] = [];
  #quiesceWaiters: Waiter[] = [];

  constructor(repository: string, binder: string) {
    this.#repository = repository;
    this.#binder = binder;
  }

  /** The host surface most recently recorded for an item, if any. */
  record(item: string): string | undefined {
    return this.#records.get(item);
  }

  /** Mark an item busy. Waits behind any requested or running quiesce. */
  async begin(item: string): Promise<void> {
    while (this.#quiesceRequested > 0) {
      await new Promise<void>((resolve) => this.#quiesceWaiters.push({ resolve }));
    }
    this.#busy.set(item, (this.#busy.get(item) ?? 0) + 1);
  }

  /**
   * Capture the item's host surface, then release it. A no-op when the item is
   * not busy, so it is safe to call from a `finally` after a `pause` ended it.
   */
  async end(item: string): Promise<void> {
    const count = this.#busy.get(item) ?? 0;
    if (count <= 0) return;
    try {
      const surface = await captureMateSurface(this.#repository, this.#binder, item);
      this.#records.set(item, surface);
    } finally {
      // Release even when the capture fails: a stuck busy count would hold every
      // later quiesce forever. Without a fresh record, a mate change made in this
      // phase fails attestation, which is the safe direction.
      const next = (this.#busy.get(item) ?? 0) - 1;
      if (next <= 0) this.#busy.delete(item);
      else this.#busy.set(item, next);
      this.#wakeBusy();
    }
  }

  /**
   * Block new `begin` calls, wait for every busy item to release, run `fn`, then
   * release the held `begin`s. Concurrent quiesce calls run one after another.
   */
  async quiesce<T>(fn: () => Promise<T>): Promise<T> {
    this.#quiesceRequested += 1;
    const previous = this.#quiesceTail;
    let release!: () => void;
    this.#quiesceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await this.#waitForIdle();
      return await fn();
    } finally {
      release();
      this.#quiesceRequested -= 1;
      if (this.#quiesceRequested === 0) {
        const waiters = this.#quiesceWaiters;
        this.#quiesceWaiters = [];
        for (const waiter of waiters) waiter.resolve();
      }
    }
  }

  /** A balanced per-item host session: `pause`/`resume`/`close`. */
  session(item: string): WaveHostSession {
    return new WaveHostSession(this, item);
  }

  #waitForIdle(): Promise<void> {
    if (this.#busy.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#busyWaiters.push({ resolve }));
  }

  #wakeBusy(): void {
    if (this.#busy.size > 0) return;
    const waiters = this.#busyWaiters;
    this.#busyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }
}

export class WaveHostSession {
  readonly #ledger: WaveHostLedger;
  readonly #item: string;
  #active = false;

  constructor(ledger: WaveHostLedger, item: string) {
    this.#ledger = ledger;
    this.#item = item;
  }

  async pause(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    await this.#ledger.end(this.#item);
  }

  async resume(): Promise<void> {
    if (this.#active) return;
    await this.#ledger.begin(this.#item);
    this.#active = true;
  }

  async close(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    await this.#ledger.end(this.#item);
  }
}
