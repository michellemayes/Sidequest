/**
 * What the Mac app needs to work on a headless session in place: whether it
 * is running, a way to stop it or run it again, what it has changed, and the
 * command that opens it interactively in a terminal tab.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { agentConfigFor, resolveAgent } from "../agents/agents.js";
import type { Config } from "../config/schema.js";
import { headlessPaths } from "../terminals/headless.js";
import { run } from "../util/exec.js";
import { pidExists } from "../util/lockfile.js";
import { autorunPaths } from "../warp/autorun.js";
import { baseRefFor } from "./sessions.js";

export interface RunState {
  /** The session runs with no terminal: it has a headless runner. */
  headless: boolean;
  /** A headless run is going right now. */
  running: boolean;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function runningPid(worktreePath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(headlessPaths(worktreePath).pidFile, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 && pidExists(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function runState(worktreePath: string): Promise<RunState> {
  if (!worktreePath) return { headless: false, running: false };
  const headless = await exists(headlessPaths(worktreePath).scriptFile);
  return { headless, running: headless && (await runningPid(worktreePath)) !== null };
}

/**
 * Stop a headless run. The runner leads its own process group (it is started
 * detached), so the agent goes with it. SIGINT first, which lets Claude Code
 * end its turn cleanly; SIGTERM if it is still there after a few seconds.
 */
export async function stopRun(worktreePath: string, graceMs = 5_000): Promise<boolean> {
  const pid = await runningPid(worktreePath);
  if (pid === null) return false;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGINT");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pidExists(pid)) await new Promise((r) => setTimeout(r, 100));
  if (pidExists(pid)) signal("SIGTERM");
  return true;
}

/** Arm a headless session to run its prompt again; reopening it then starts the run. */
export async function armRunAgain(worktreePath: string): Promise<void> {
  await writeFile(autorunPaths(worktreePath).pendingFile, "", "utf8");
}

export interface ChangedFile {
  path: string;
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  removed: number | null;
  /** "added" for a file git does not track yet. */
  status: "modified" | "added" | "deleted";
}

/** Where the session's branch left its base: what its changes are measured from. */
async function mergeBase(config: Config, repoPath: string, worktreePath: string): Promise<string | null> {
  const base = await baseRefFor(config, repoPath);
  if (!base) return null;
  try {
    return (await run("git", ["merge-base", "HEAD", base], { cwd: worktreePath, timeoutMs: 10_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Everything the session changed since its base, committed or not, untracked files included. */
export async function changedFiles(config: Config, repoPath: string, worktreePath: string): Promise<{ base: string | null; files: ChangedFile[] }> {
  const base = await mergeBase(config, repoPath, worktreePath);
  const files: ChangedFile[] = [];
  const git = (args: string[]) => run("git", ["--no-optional-locks", ...args], { cwd: worktreePath, timeoutMs: 15_000 });
  try {
    const numstat = (await git(["diff", "--numstat", "--no-renames", base ?? "HEAD"])).stdout;
    const deleted = new Set(
      (await git(["diff", "--name-only", "--diff-filter=D", base ?? "HEAD"])).stdout.split("\n").filter(Boolean),
    );
    for (const line of numstat.split("\n")) {
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      files.push({
        path,
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
        status: deleted.has(path) ? "deleted" : "modified",
      });
    }
    const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean);
    for (const path of untracked) {
      const lines = await readFile(`${worktreePath}/${path}`, "utf8").then(
        (t) => (t.length === 0 ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0)),
        () => null,
      );
      files.push({ path, added: lines, removed: 0, status: "added" });
    }
  } catch {
    // Not readable as a repo right now; nothing to show.
  }
  return { base, files };
}

/** One file's diff against the session's base, as a unified patch. */
export async function fileDiff(config: Config, repoPath: string, worktreePath: string, path: string): Promise<string> {
  if (!path || path.includes("\0")) return "";
  const base = await mergeBase(config, repoPath, worktreePath);
  try {
    const tracked = (await run("git", ["ls-files", "--error-unmatch", "--", path], { cwd: worktreePath, timeoutMs: 10_000 }).then(() => true, () => false));
    if (!tracked) {
      // git diff --no-index exits 1 when the files differ, which they always do here.
      return await run("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: worktreePath, timeoutMs: 15_000 }).then(
        (r) => r.stdout,
        (err: { stdout?: string }) => err.stdout ?? "",
      );
    }
    return (await run("git", ["--no-optional-locks", "diff", base ?? "HEAD", "--", path], { cwd: worktreePath, timeoutMs: 15_000 })).stdout;
  } catch {
    return "";
  }
}

/**
 * The command that opens the session interactively, carrying on its
 * conversation where the agent can: what a terminal tab in the app runs.
 */
export function terminalCommand(config: Config, agentId: string): string[] {
  const agent = resolveAgent(agentConfigFor(config.settings.agent, agentId), config.settings);
  return [agent.command, ...(agent.continueArgs ?? []), ...agent.args];
}
