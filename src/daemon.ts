/**
 * The background daemon behind `sidequest start`.
 *
 * `start` (without --foreground) spawns a detached child that runs the Slack
 * attacher loop, then exits. The child records its pid here so `stop` and
 * `status` can find it, and removes the record on shutdown. Everything lives
 * under the config root, so SIDEQUEST_HOME keeps tests isolated.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { daemonPidFile } from "./config/paths.js";

export interface DaemonRecord {
  pid: number;
  startedAt: string;
  /**
   * The commit of the build the daemon started on ("" for an unstamped build),
   * so `update` can tell a daemon still running old code. Missing from records
   * written before this was tracked.
   */
  build?: string;
}

export async function readDaemonRecord(): Promise<DaemonRecord | null> {
  try {
    const raw = await readFile(daemonPidFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonRecord>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      ...(typeof parsed.build === "string" ? { build: parsed.build } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeDaemonRecord(build: string): Promise<void> {
  const record: DaemonRecord = { pid: process.pid, startedAt: new Date().toISOString(), build };
  await writeFile(daemonPidFile(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function clearDaemonRecord(): Promise<void> {
  try {
    await rm(daemonPidFile(), { force: true });
  } catch {
    // Already gone; nothing to do.
  }
}

/** True when a process with this pid exists (and we may signal it). */
export function daemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
