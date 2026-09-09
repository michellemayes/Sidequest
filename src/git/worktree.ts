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

  if (options.fetch && repo.hasRemote) {
    await fetchQuietly(repo.root, baseBranch);
  }

  const baseRef = await resolveBaseRef(repo.root, baseBranch, repo.hasRemote);
  await mkdir(worktreesRoot, { recursive: true });

  const { branch, path } = await findFreeNames(repo, options.branch, worktreesRoot);

  try {
    await run("git", ["worktree", "add", "-b", branch, path, baseRef], {
      cwd: repo.root,
      timeoutMs: 180_000,
    });
  } catch (err) {
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

    const taken = (await branchExists(repo.root, branch)) || (await pathExists(path));
    if (!taken) return { branch, path };
  }

  throw new UserFacingError(
    `Could not find a free branch name based on "${desiredBranch}" after 50 tries.`,
    "Clean up old sessions with `ccslack clean`.",
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
