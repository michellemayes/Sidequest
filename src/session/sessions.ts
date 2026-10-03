/**
 * The sessions panel inside Slack: which of your recent sessions still have a
 * worktree, what state each is in, and a way to be rid of a finished one.
 *
 * History says what was started, from where, and when; git says what is left
 * of it. The panel wants both, so this reads history for the list and asks
 * git only about the few sessions it will actually show. It is read-mostly
 * and has to be quick — it runs while someone is looking at a panel in Slack —
 * so every probe is cheap (a worktree list per repo, then a status and a
 * rev-list per session, all side by side) and any one that fails or is slow
 * just leaves its field unknown rather than holding up the rest.
 *
 * What reaches the page is deliberately thin, as with everything else the
 * overlay sees: branch names, repo labels, channel names and counts. Not
 * paths. A session is named to the daemon by its worktree's directory name,
 * which is unique under worktreesRoot and says nothing the branch does not.
 */
import { basename, join } from "node:path";
import type { Config } from "../config/schema.js";
import { detectDefaultBranch, refExists } from "../git/repo.js";
import { listWorktrees, pruneWorktrees, removeWorktree, type WorktreeRecord } from "../git/worktree.js";
import { run, succeeds } from "../util/exec.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import { autorunPaths } from "../warp/autorun.js";
import { baseBranchFor } from "./cleanup.js";
import type { HistoryEntry } from "./history.js";
import { findSession, type FoundSession } from "./reopen.js";
import { exists } from "../util/fs.js";

/** How many sessions the panel lists, newest first. */
export const PANEL_LIMIT = 15;

/** A probe slower than this is not worth the panel waiting for. */
const PROBE_MS = 5_000;

export interface SessionSummary {
  /** The worktree's directory name: how the page names a session back to the daemon. */
  id: string;
  branch: string;
  /** The repo's label, as the channel pill shows it. */
  repo: string;
  channel: string;
  promptKey: string;
  promptLabel: string;
  createdAt: string;
  /**
   * `active` has a worktree on disk; `gone` is still registered with git but
   * its directory has been deleted, so there is nothing to reopen, only a
   * registration (and maybe a branch) to clean up.
   */
  state: "active" | "gone";
  /** Commits on the branch that its base does not have; null when unknown. */
  ahead: number | null;
  /** Uncommitted files — changed, staged or untracked; null when unknown. */
  dirty: number | null;
  /** The agent has not started yet: the launcher's marker is still unclaimed. */
  pending: boolean;
}

/**
 * The most recent sessions that still have something on disk, newest first.
 * A session `sidequest clean` (or the panel) already removed has no worktree
 * registered any more and is left out; history keeps it for the stats.
 */
export async function listSessions(
  config: Config,
  history: HistoryEntry[],
  limit = PANEL_LIMIT,
): Promise<SessionSummary[]> {
  // Newest first, once per worktree: a history entry is written per start,
  // and a path is only ever one session's.
  const seen = new Set<string>();
  const candidates: HistoryEntry[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]!;
    if (!entry.worktreePath || !entry.repoPath || seen.has(entry.worktreePath)) continue;
    seen.add(entry.worktreePath);
    candidates.push(entry);
  }

  // One worktree list per repo tells which of them are still there.
  const repos = [...new Set(candidates.map((c) => c.repoPath))];
  const registered = new Map<string, Map<string, WorktreeRecord>>();
  await Promise.all(repos.map(async (repoPath) => {
    try {
      const list = await listWorktrees(repoPath);
      registered.set(repoPath, new Map(list.map((w) => [w.path, w])));
    } catch {
      // The repo itself is gone or unreadable; its sessions go with it.
    }
  }));

  const shown: Array<{ entry: HistoryEntry; record: WorktreeRecord }> = [];
  for (const entry of candidates) {
    const record = registered.get(entry.repoPath)?.get(entry.worktreePath);
    if (!record || record.isMain) continue;
    shown.push({ entry, record });
    if (shown.length >= limit) break;
  }

  const bases = new Map<string, Promise<string | null>>();
  const baseFor = (repoPath: string): Promise<string | null> => {
    let base = bases.get(repoPath);
    if (!base) {
      base = baseRefFor(config, repoPath);
      bases.set(repoPath, base);
    }
    return base;
  };

  return Promise.all(shown.map(async ({ entry, record }) => {
    const summary: SessionSummary = {
      id: basename(entry.worktreePath),
      branch: record.branch,
      repo: entry.repoLabel || basename(entry.repoPath),
      channel: entry.channel,
      promptKey: entry.promptKey,
      promptLabel: entry.promptLabel,
      createdAt: entry.createdAt,
      state: "active",
      ahead: null,
      dirty: null,
      pending: false,
    };
    if (record.isPrunable || !(await exists(entry.worktreePath))) {
      summary.state = "gone";
      return summary;
    }
    const [ahead, dirty, pending] = await Promise.all([
      baseFor(entry.repoPath).then((base) => (base ? aheadOf(entry.repoPath, record.branch, base) : null)),
      dirtyCount(entry.worktreePath),
      exists(autorunPaths(entry.worktreePath).pendingFile),
    ]);
    Object.assign(summary, { ahead, dirty, pending });
    return summary;
  }));
}

export interface RemoveSessionResult {
  branch: string;
  /** The worktree directory is gone (or already was). */
  removedWorktree: boolean;
  /** The branch went too; it stays when it holds commits the base lacks. */
  removedBranch: boolean;
}

/**
 * Thrown when a worktree has uncommitted work and the caller did not say to
 * discard it. Carries the count so the page can say what would be lost.
 */
export class UncommittedWorkError extends UserFacingError {
  constructor(readonly branch: string, readonly dirty: number) {
    super(
      `${branch} has ${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}.`,
      "Commit them first, or confirm to discard them.",
    );
    this.name = "UncommittedWorkError";
  }
}

/**
 * Remove one session's worktree, with the same rules as `sidequest clean`
 * (sweepWorktrees in cleanup.ts, which works a whole repo at a time):
 * git refuses to remove a worktree with uncommitted changes unless forced,
 * and the branch is only deleted (when pruneBranchesOnClean is on) if it has
 * nothing the base lacks — `git branch -d`, never `-D`. The one difference is
 * that this does not insist on the branch being merged first, because it is
 * one session someone picked, not a sweep; its commits stay on the branch.
 *
 * Uncommitted work is checked here first as well as by git, so the refusal
 * can say how much would be lost rather than just that something would.
 */
export async function removeSession(
  config: Config,
  history: HistoryEntry[],
  id: string,
  options: { force?: boolean } = {},
): Promise<RemoveSessionResult> {
  const found = await findById(config, history, id);
  if (!found) {
    throw new UserFacingError("That session is already gone.");
  }
  const { worktree, repoPath } = found;
  const deleteBranch = config.settings.pruneBranchesOnClean && worktree.branch !== "(detached)"
    ? worktree.branch
    : undefined;

  if (worktree.isPrunable || !(await exists(worktree.path))) {
    // Deleted by hand: all that is left is git's registration of it.
    await pruneWorktrees(repoPath);
    const removedBranch = deleteBranch
      ? await succeeds("git", ["branch", "-d", deleteBranch], { cwd: repoPath })
      : false;
    log.info(`dropped the registration of ${worktree.path}`);
    return { branch: worktree.branch, removedWorktree: true, removedBranch };
  }

  if (!options.force) {
    const dirty = await dirtyCount(worktree.path);
    if (dirty === null) {
      throw new UserFacingError(
        `Could not tell whether ${worktree.branch} has uncommitted changes.`,
        "Left it alone. Try `sidequest clean` from the terminal.",
      );
    }
    if (dirty > 0) throw new UncommittedWorkError(worktree.branch, dirty);
  }

  const result = await removeWorktree(repoPath, worktree.path, { force: options.force, deleteBranch });
  if (!result.removedWorktree) {
    // Something changed between the check and the removal, or git has its
    // own reason (a lock). Either way nothing was touched.
    throw new UserFacingError(
      `git would not remove the worktree for ${worktree.branch}.`,
      "It may have changes made a moment ago, or be locked. Nothing was deleted.",
    );
  }
  log.info(`removed ${worktree.path} from the overlay${result.removedBranch ? ` and branch ${worktree.branch}` : ""}`);
  return { branch: worktree.branch, ...result };
}

/**
 * A session by its worktree's directory name. Only a plain name is accepted —
 * no separators, no `..` — and findSession then only matches a registered,
 * non-main worktree under worktreesRoot, so the page cannot point this at
 * anything Sidequest did not create.
 */
export async function findById(
  config: Config,
  history: HistoryEntry[],
  id: string,
): Promise<FoundSession | null> {
  const name = id.trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return null;
  const path = join(config.settings.worktreesRoot, name);
  const known = history.filter((h) => h.worktreePath === path).map((h) => h.repoPath);
  return findSession(config, path, known);
}

/** The ref a session's commits are counted against: origin/<base> when it exists. */
async function baseRefFor(config: Config, repoPath: string): Promise<string | null> {
  try {
    const base = baseBranchFor(config, repoPath) || await detectDefaultBranch(repoPath, true);
    if (await refExists(repoPath, `origin/${base}`)) return `origin/${base}`;
    if (await refExists(repoPath, base)) return base;
  } catch {
    // Unknown base: the panel just does not count commits.
  }
  return null;
}

async function aheadOf(repoPath: string, branch: string, base: string): Promise<number | null> {
  try {
    const { stdout } = await run("git", ["rev-list", "--count", `${base}..${branch}`], {
      cwd: repoPath,
      timeoutMs: PROBE_MS,
    });
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * What `git worktree remove` would refuse over: modified, staged and
 * untracked files. The session's own `.sidequest/` is excluded from git, so
 * it never counts.
 */
export async function dirtyCount(worktreePath: string): Promise<number | null> {
  try {
    // Only reading: without --no-optional-locks, status takes index.lock to
    // refresh the index, and the agent may be committing in this worktree.
    const { stdout } = await run("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], {
      cwd: worktreePath,
      timeoutMs: PROBE_MS,
    });
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return null;
  }
}


