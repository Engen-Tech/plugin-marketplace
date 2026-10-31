import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "./package-paths.ts";

const exec = promisify(execFile);
const BINDER_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_SCHEMA = 1;

interface LockOwner {
  schema: number;
  binder: string;
  pid: number;
  hostname: string;
  processStartedAt: string;
  nonce: string;
  packageVersion: string;
  acquiredAt: string;
}

export interface DispatchLockInspection {
  lockPath: string;
  owner?: LockOwner;
  ownerAppearsActive?: boolean;
  readable: boolean;
}

export class DispatchLockError extends Error {
  readonly inspection: DispatchLockInspection;

  constructor(message: string, inspection: DispatchLockInspection) {
    super(message);
    this.name = "DispatchLockError";
    this.inspection = inspection;
  }
}

function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function processAppearsActive(owner: LockOwner): boolean | undefined {
  if (owner.hostname !== hostname()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

let packageVersion: string | undefined;

async function getPackageVersion(): Promise<string> {
  if (packageVersion) return packageVersion;
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  if (typeof manifest.version !== "string") throw new Error("Hatch package version is missing");
  const version = manifest.version as string;
  packageVersion = version;
  return version;
}

export async function resolveDispatchLockPath(cwd: string, binder: string): Promise<string> {
  if (!BINDER_SLUG.test(binder)) throw new Error(`Invalid Hatch binder slug: ${binder}`);
  const { stdout } = await exec(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { maxBuffer: 1024 * 1024 },
  );
  const commonDir = stdout.trim();
  if (!commonDir) throw new Error(`Cannot resolve Git common directory from ${cwd}`);
  return join(commonDir, "hatch-locks", `${binder}.lock`);
}

export async function inspectDispatchLock(lockPath: string): Promise<DispatchLockInspection> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as LockOwner;
    if (
      owner.schema !== LOCK_SCHEMA ||
      typeof owner.binder !== "string" ||
      !Number.isInteger(owner.pid) ||
      typeof owner.hostname !== "string" ||
      typeof owner.processStartedAt !== "string" ||
      typeof owner.nonce !== "string" ||
      typeof owner.packageVersion !== "string" ||
      typeof owner.acquiredAt !== "string"
    ) {
      return { lockPath, readable: false };
    }
    return {
      lockPath,
      owner,
      ownerAppearsActive: processAppearsActive(owner),
      readable: true,
    };
  } catch {
    return { lockPath, readable: false };
  }
}

export class DispatchLockLease {
  readonly lockPath: string;
  readonly owner: LockOwner;
  #released = false;
  #releasePromise: Promise<void> | undefined;

  constructor(lockPath: string, owner: LockOwner) {
    this.lockPath = lockPath;
    this.owner = owner;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    if (this.#releasePromise) return this.#releasePromise;
    this.#releasePromise = this.#release();
    try {
      await this.#releasePromise;
    } catch (error) {
      this.#releasePromise = undefined;
      throw error;
    }
  }

  async #release(): Promise<void> {
    const inspection = await inspectDispatchLock(this.lockPath);
    if (!inspection.readable || inspection.owner?.nonce !== this.owner.nonce) {
      throw new DispatchLockError(
        `Hatch dispatch lock ownership changed; refusing to release ${this.lockPath}`,
        inspection,
      );
    }
    const releasePath = `${this.lockPath}.release-${this.owner.nonce}`;
    await rename(this.lockPath, releasePath);
    await rm(releasePath, { recursive: true, force: true });
    this.#released = true;
  }
}

export async function acquireDispatchLock(
  cwd: string,
  binder: string,
): Promise<DispatchLockLease> {
  const lockPath = await resolveDispatchLockPath(cwd, binder);
  const version = await getPackageVersion();
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const inspection = await inspectDispatchLock(lockPath);
    const owner = inspection.owner;
    const activity =
      inspection.ownerAppearsActive === true
        ? "owner process appears active"
        : inspection.ownerAppearsActive === false
          ? "owner process is absent; verify and remove the stale lock explicitly"
          : "owner activity is unknown; verify the lock explicitly";
    throw new DispatchLockError(
      owner
        ? `Hatch binder '${binder}' is already locked by PID ${owner.pid} on ${owner.hostname}; ${activity}`
        : `Hatch binder '${binder}' has an unreadable dispatch lock at ${lockPath}; refusing to steal it`,
      inspection,
    );
  }

  const owner: LockOwner = {
    schema: LOCK_SCHEMA,
    binder,
    pid: process.pid,
    hostname: hostname(),
    processStartedAt: processStartedAt(),
    nonce: randomUUID(),
    packageVersion: version,
    acquiredAt: new Date().toISOString(),
  };
  try {
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return new DispatchLockLease(lockPath, owner);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

export class DispatchLockManager {
  readonly #leases = new Map<string, DispatchLockLease>();

  async acquire(cwd: string, binder: string): Promise<DispatchLockLease> {
    const lease = await acquireDispatchLock(cwd, binder);
    this.#leases.set(lease.lockPath, lease);
    return lease;
  }

  async release(lease: DispatchLockLease): Promise<void> {
    await lease.release();
    this.#leases.delete(lease.lockPath);
  }

  owns(lease: DispatchLockLease): boolean {
    return this.#leases.get(lease.lockPath) === lease;
  }

  async releaseAll(): Promise<void> {
    const leases = [...this.#leases.values()];
    const results = await Promise.allSettled(leases.map((lease) => lease.release()));
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") this.#leases.delete(leases[index].lockPath);
    }
  }

  get size(): number {
    return this.#leases.size;
  }
}
