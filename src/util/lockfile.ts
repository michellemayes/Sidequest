/**
 * Lock files shared between processes: created with O_EXCL ("wx"), so only
 * one process can hold one at a time, and holding the holder's pid so a lock
 * left behind by a process that died can be taken over.
 */
import { open, readFile, rm, stat } from "node:fs/promises";

export interface LockHolder {
  pid: number;
  /** When it was taken, epoch ms. */
  at: number;
  /** Anything else the holder wants recognised by, e.g. the daemon's entry script. */
  [key: string]: unknown;
}

/** True when a process with this pid exists, whether or not we may signal it. */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readLockHolder(path: string): Promise<LockHolder | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return { ...parsed, pid: parsed.pid, at: typeof parsed.at === "number" ? parsed.at : 0 };
  } catch {
    return null;
  }
}

/**
 * Whether a lock found on disk can be taken over. `holder` is null when the
 * file is there but unreadable, which is either a holder mid-write or debris.
 */
export type StaleCheck = (holder: LockHolder | null, ageMs: number) => boolean | Promise<boolean>;

/**
 * Take the lock once. Returns null on success, or whoever holds it. A stale
 * lock is removed and taken; the content is compared again just before the
 * removal, so two processes taking over the same stale lock do not remove
 * each other's fresh one (short of a race inside that window, which costs a
 * retry rather than correctness for the callers here).
 */
export async function tryLock(
  path: string,
  isStale: StaleCheck,
  extra: Record<string, unknown> = {},
): Promise<LockHolder | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const holder: LockHolder = { ...extra, pid: process.pid, at: Date.now() };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(holder)}\n`);
      } finally {
        await handle.close();
      }
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const existing = await readLockHolder(path);
    let ageMs = 0;
    try {
      ageMs = Date.now() - (await stat(path)).mtimeMs;
    } catch {
      // Released between the open and now: just try again.
      continue;
    }
    if (!(await isStale(existing, ageMs))) {
      return existing ?? { pid: 0, at: 0 };
    }
    const again = await readLockHolder(path);
    if (JSON.stringify(again) !== JSON.stringify(existing)) continue;
    await rm(path, { force: true });
  }
  return (await readLockHolder(path)) ?? { pid: 0, at: 0 };
}

/**
 * Take the lock, retrying every `retryMs` until `timeoutMs` has passed.
 * Returns null once held, or the holder that kept it.
 */
export async function acquireLock(
  path: string,
  options: { isStale: StaleCheck; timeoutMs: number; retryMs?: number; extra?: Record<string, unknown> },
): Promise<LockHolder | null> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const holder = await tryLock(path, options.isStale, options.extra);
    if (holder === null) return null;
    if (Date.now() >= deadline) return holder;
    await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 25));
  }
}

/** Remove the lock, but only if this process is the one holding it. */
export async function releaseLock(path: string): Promise<void> {
  const holder = await readLockHolder(path);
  if (holder?.pid !== process.pid) return;
  await rm(path, { force: true });
}
