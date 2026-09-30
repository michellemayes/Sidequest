import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, succeeds } from "../util/exec.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import {
  branchExists,
  ensureSessionDirIgnored,
  fetchQuietly,
  resolveBaseRef,
  type RepoInfo,
} from "./repo.js";
import { SESSION_DIR } from "../warp/autorun.js";

export interface CreateWorktreeOptions {
  repo: RepoInfo;
  /** Desired branch name; a numeric suffix is added if it is already taken. */
  branch: string;
  baseBranch: string;
  /** Parent directory that will hold the worktree directory. */
  worktreesRoot: string;
  fetch: boolean;
  /**
   * How long the fetch may hold up the session. A slower one keeps running in
   * the background and the worktree is cut from the local ref.
   */
  fetchWaitMs?: number;
  /**
   * Runs alongside `git worktree add` once the names are settled, so work that
   * only needs the path (writing Warp's tab config) overlaps the checkout. If
   * the checkout fails, this has still run.
   */
  alongsideCheckout?: (names: { branch: string; path: string }) => Promise<void>;
}

export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
}

/**
 * Cut a fresh branch and check it out into its own worktree.
 *
 * Both the branch name and the directory name get the same suffix when they
 * collide, so the two stay in step and repeated clicks on the same Slack
 * message produce session-2, session-3 rather than failing.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const { repo, baseBranch, worktreesRoot } = options;

  // The fetch is the slowest step and needs nothing else, so the local lookups
  // run while it is in flight.
  const fetched = options.fetch && repo.hasRemote ? fetchQuietly(repo.root, baseBranch) : null;

  await mkdir(worktreesRoot, { recursive: true });
  const { branch, path } = await findFreeNames(repo, options.branch, worktreesRoot);

  if (fetched) {
    const waitMs = options.fetchWaitMs ?? FETCH_WAIT_MS;
    const inTime = await Promise.race([fetched.then(() => true), sleep(waitMs).then(() => false)]);
    if (!inTime) log.warn(`fetching origin/${baseBranch} is taking over ${waitMs}ms; cutting from the local ref`);
  }

  const baseRef = await resolveBaseRef(repo.root, baseBranch, repo.hasRemote);

  const [added] = await Promise.allSettled([
    run("git", ["worktree", "add", "-b", branch, path, baseRef], {
      cwd: repo.root,
      timeoutMs: 180_000,
    }),
    options.alongsideCheckout?.({ branch, path }),
  ]);
  if (added.status === "rejected") {
    const err: unknown = added.reason;
    throw new UserFacingError(
      `Could not create a worktree in ${repo.root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Do this after the worktree exists so a failed creation leaves no trace.
  await ensureSessionDirIgnored(repo.root, SESSION_DIR);

  log.info(`created worktree ${path} on ${branch} from ${baseRef}`);
  return { path, branch, baseBranch, baseRef };
}

/**
 * A fetch over a good link finishes well inside this; one that does not is
 * better skipped than waited on, since the local ref is usually close.
 */
const FETCH_WAIT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Find a branch name and directory path that are both free, appending the same
 * -N suffix to each until they are.
 */
async function findFreeNames(
  repo: RepoInfo,
  desiredBranch: string,
  worktreesRoot: string,
): Promise<{ branch: string; path: string }> {
  const dirName = desiredBranch.replace(/\//g, "-");

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const branch = `${desiredBranch}${suffix}`;
    const path = join(worktreesRoot, `${dirName}${suffix}`);

    const [branchTaken, pathTaken] = await Promise.all([branchExists(repo.root, branch), pathExists(path)]);
    const taken = branchTaken || pathTaken;
    if (!taken) return { branch, path };
  }

  throw new UserFacingError(
    `Could not find a free branch name based on "${desiredBranch}" after 50 tries.`,
    "Clean up old sessions with `sidequest clean`.",
  );
}

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeRecord {
  path: string;
  branch: string;
  isMain: boolean;
  isPrunable: boolean;
}

/** Parse `git worktree list --porcelain` into records. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeRecord[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const records: WorktreeRecord[] = [];
  let current: Partial<WorktreeRecord> = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      // A blank line separates entries, but flush on the next header too in
      // case the final entry has no trailing newline.
      if (current.path) records.push(finalize(current, records.length === 0));
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "prunable" || line.startsWith("prunable ")) {
      current.isPrunable = true;
    } else if (line.trim() === "") {
      if (current.path) {
        records.push(finalize(current, records.length === 0));
        current = {};
      }
    }
  }
  if (current.path) records.push(finalize(current, records.length === 0));
  return records;
}

function finalize(partial: Partial<WorktreeRecord>, isMain: boolean): WorktreeRecord {
  return {
    path: partial.path ?? "",
    branch: partial.branch ?? "(detached)",
    isMain,
    isPrunable: partial.isPrunable ?? false,
  };
}

export interface RemoveResult {
  removedWorktree: boolean;
  removedBranch: boolean;
}

/**
 * Remove a worktree and optionally its branch. `force` discards uncommitted
 * changes in the worktree, so callers must only pass it deliberately.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: { force?: boolean; deleteBranch?: string } = {},
): Promise<RemoveResult> {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreePath);

  const removedWorktree = await succeeds("git", args, { cwd: repoRoot, timeoutMs: 60_000 });
  if (!removedWorktree) {
    log.warn(`could not remove worktree ${worktreePath} (uncommitted changes?)`);
    return { removedWorktree: false, removedBranch: false };
  }

  let removedBranch = false;
  if (options.deleteBranch) {
    // -d refuses to delete a branch holding unmerged commits, which is what we
    // want: never silently throw away work.
    removedBranch = await succeeds("git", ["branch", "-d", options.deleteBranch], { cwd: repoRoot });
    if (!removedBranch) {
      log.info(`kept branch ${options.deleteBranch} — it has unmerged commits`);
    }
  }
  return { removedWorktree, removedBranch };
}

/** Drop worktree registrations whose directories are gone. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await succeeds("git", ["worktree", "prune"], { cwd: repoRoot });
}
