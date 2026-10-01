/**
 * The background daemon behind `sidequest start`.
 *
 * `start` (without --foreground) spawns a detached child that runs the Slack
 * attacher loop, then exits. The child records its pid here so `stop` and
 * `status` can find it, and removes the record on shutdown. Everything lives
 * under the config root, so SIDEQUEST_HOME keeps tests isolated.
 */
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { daemonLockFile, daemonPidFile } from "./config/paths.js";
import { run } from "./util/exec.js";
import { pidExists, releaseLock, tryLock, type LockHolder } from "./util/lockfile.js";

export interface DaemonRecord {
  pid: number;
  startedAt: string;
  /**
   * The commit of the build the daemon started on ("" for an unstamped build),
   * so `update` can tell a daemon still running old code. Missing from records
   * written before this was tracked.
   */
  build?: string;
  /**
   * The script the daemon runs (its argv[1]), to recognise its process by.
   * Missing from records written before this was tracked.
   */
  entry?: string;
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
      ...(typeof parsed.entry === "string" ? { entry: parsed.entry } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Written to a temp file and renamed into place, so `start` polling for it
 * never reads a half-written record and takes the daemon for dead.
 */
export async function writeDaemonRecord(build: string): Promise<void> {
  const record: DaemonRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build,
    entry: process.argv[1] ?? "",
  };
  const file = daemonPidFile();
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export async function clearDaemonRecord(): Promise<void> {
  try {
    await rm(daemonPidFile(), { force: true });
  } catch {
    // Already gone; nothing to do.
  }
}

/** What a process says about itself: its command line and when it started. */
export interface ProcessInfo {
  args: string;
  /** Epoch ms, or null when ps's date could not be read. */
  startedMs: number | null;
}

/** `ps` for one pid; null when there is no such process or no ps to ask. */
export async function processInfo(pid: number): Promise<ProcessInfo | null> {
  try {
    // LC_ALL=C keeps lstart in the English format Date.parse reads.
    const { stdout } = await run("ps", ["-o", "lstart=", "-o", "args=", "-p", String(pid)], {
      timeoutMs: 5_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    const line = stdout.split("\n").find((l) => l.trim().length > 0);
    if (!line) return null;
    // lstart is a fixed five fields: "Wed Oct  1 15:54:26 2026".
    const fields = line.trim().split(/\s+/);
    const startedMs = Date.parse(fields.slice(0, 5).join(" "));
    return { args: fields.slice(5).join(" "), startedMs: Number.isFinite(startedMs) ? startedMs : null };
  } catch {
    return null;
  }
}

/** How far a process's start may trail the time it recorded, for ps's whole seconds and clock skew. */
const START_SLACK_MS = 60_000;

/**
 * Whether this pid is a Sidequest daemon, and the one that wrote `record`.
 *
 * A pid outlives its process: after a crash or a reboot the pid file can
 * name a pid the OS has since handed to something else. Taking that for the
 * daemon would block `start` forever and have `stop` kill a stranger, so the
 * process has to look like ours: running the recorded script's `start` (or,
 * for an older record, something called sidequest), and started no later
 * than the record says the daemon did.
 */
export async function isSidequestProcess(
  pid: number,
  record: { entry?: string; startedAt?: string | number } = {},
): Promise<boolean> {
  if (!pidExists(pid)) return false;
  const info = await processInfo(pid);
  // No ps (or it failed): existence is all there is to go on.
  if (info === null) return pidExists(pid);
  const entry = record.entry?.trim();
  // `start` too: any other sidequest command (a `status` that happens to get
  // the old pid) runs the same script.
  const looksLikeOurs =
    (entry ? info.args.includes(entry) : /sidequest/i.test(info.args)) && /\sstart(\s|$)/.test(info.args);
  if (!looksLikeOurs) return false;
  const recorded =
    typeof record.startedAt === "number" ? record.startedAt : Date.parse(record.startedAt ?? "");
  if (Number.isFinite(recorded) && recorded > 0 && info.startedMs !== null) {
    // A process that started after the record was written did not write it.
    if (info.startedMs > recorded + START_SLACK_MS) return false;
  }
  return true;
}

/** True when the recorded daemon is running: its pid is alive and is still a Sidequest daemon. */
export async function daemonAlive(record: DaemonRecord): Promise<boolean> {
  return isSidequestProcess(record.pid, record);
}

/**
 * Take the daemon lock, so a second daemon (a `start` racing another, or a
 * --foreground run beside the background one) cannot attach a second overlay.
 * Returns null once held, or the daemon that holds it. A lock whose holder is
 * gone, or is no longer a Sidequest process, is taken over.
 */
export async function lockDaemon(): Promise<LockHolder | null> {
  return tryLock(
    daemonLockFile(),
    async (holder, ageMs) => {
      if (holder === null) return ageMs > 2_000;
      if (holder.pid === process.pid) return true;
      return !(await isSidequestProcess(holder.pid, {
        entry: typeof holder.entry === "string" ? holder.entry : undefined,
        startedAt: holder.at,
      }));
    },
    { entry: process.argv[1] ?? "" },
  );
}

export async function unlockDaemon(): Promise<void> {
  await releaseLock(daemonLockFile()).catch(() => undefined);
}

/** The daemon's log is rotated at start once it passes this. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Keep the log from growing without bound: past `maxBytes`, move it to
 * `<log>.1` (replacing the previous one) and start a fresh one. Done by
 * `start` before the daemon opens it, since the daemon's output goes
 * straight to the file.
 */
export async function rotateLog(file: string, maxBytes = LOG_ROTATE_BYTES): Promise<boolean> {
  try {
    if ((await stat(file)).size <= maxBytes) return false;
    await rename(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** The last `bytes` of a file, starting at a whole line; "" when it cannot be read. */
export async function readTail(file: string, bytes = 64 * 1024): Promise<string> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // The first line is probably cut short; drop it unless this is the whole file.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}
