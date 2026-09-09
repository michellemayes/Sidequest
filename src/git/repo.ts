import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { run, succeeds, CommandError } from "../util/exec.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";

export interface RepoInfo {
  /** The path the user gave us, resolved to the repository's top level. */
  root: string;
  /** Directory name, used as the default label. */
  name: string;
  defaultBranch: string;
  hasRemote: boolean;
}

export async function assertGitAvailable(): Promise<void> {
  if (!(await succeeds("git", ["--version"]))) {
    throw new UserFacingError(
      "git is not installed or not on PATH.",
      "Install git and restart ccslack.",
    );
  }
}

/**
 * Resolve a user-supplied path to the top level of its git repository.
 * Accepts any directory inside the repo, not just the root.
 */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  let entry;
  try {
    entry = await stat(path);
  } catch {
    throw new UserFacingError(`No such directory: ${path}`);
  }
  if (!entry.isDirectory()) {
    throw new UserFacingError(`Not a directory: ${path}`);
  }

  let root: string;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: path });
    root = stdout.trim();
  } catch (err) {
    if (err instanceof CommandError) {
      throw new UserFacingError(
        `${path} is not inside a git repository.`,
        "Point ccslack at a git checkout, or run `git init` there first.",
      );
    }
    throw err;
  }

  // A repo with no commits has no branch to cut a worktree from.
  if (!(await succeeds("git", ["rev-parse", "HEAD"], { cwd: root }))) {
    throw new UserFacingError(
      `${root} has no commits yet.`,
      "Make at least one commit before linking the repo.",
    );
  }

  const hasRemote = (await run("git", ["remote"], { cwd: root })).stdout.trim().length > 0;
  return {
    root,
    name: basename(root),
    defaultBranch: await detectDefaultBranch(root, hasRemote),
    hasRemote,
  };
}

/**
 * Work out what to branch from, in descending order of trustworthiness:
 * the remote's published HEAD, then a conventional name that exists locally,
 * then whatever branch is currently checked out.
 */
export async function detectDefaultBranch(root: string, hasRemote: boolean): Promise<string> {
  if (hasRemote) {
    try {
      const { stdout } = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: root,
      });
      const ref = stdout.trim();
      if (ref.startsWith("origin/")) return ref.slice("origin/".length);
    } catch {
      log.debug("origin/HEAD not set; falling back to conventional branch names");
    }
  }

  for (const candidate of ["main", "master", "develop", "trunk"]) {
    if (await branchExists(root, candidate)) return candidate;
  }

  try {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    const current = stdout.trim();
    if (current && current !== "HEAD") return current;
  } catch {
    // fall through
  }
  return "main";
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  return succeeds("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
}

/** True if `ref` resolves to anything at all (branch, tag, remote ref, sha). */
export async function refExists(root: string, ref: string): Promise<boolean> {
  return succeeds("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root });
}

/**
 * Pick the ref to actually branch from. Prefer origin/<base> when it exists so
 * the worktree starts from what the team has, not a stale local branch.
 */
export async function resolveBaseRef(
  root: string,
  baseBranch: string,
  hasRemote: boolean,
): Promise<string> {
  if (hasRemote && (await refExists(root, `origin/${baseBranch}`))) return `origin/${baseBranch}`;
  if (await refExists(root, baseBranch)) return baseBranch;
  throw new UserFacingError(
    `Base branch "${baseBranch}" does not exist in ${root}.`,
    "Set a different base with `ccslack link <repo> --base <branch>`.",
  );
}

/** Best-effort fetch. A network failure must not block creating the session. */
export async function fetchQuietly(root: string, baseBranch: string): Promise<void> {
  try {
    await run("git", ["fetch", "--quiet", "origin", baseBranch], { cwd: root, timeoutMs: 45_000 });
  } catch (err) {
    log.warn(`could not fetch origin/${baseBranch}; using the local ref instead`, describe(err));
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when every commit on `branch` is already contained in `base`, i.e. the
 * branch has nothing left to lose. Used to decide what `ccslack clean` may
 * remove without being asked twice.
 */
export async function isMergedInto(
  root: string,
  branch: string,
  base: string,
): Promise<boolean> {
  const baseRef = (await refExists(root, `origin/${base}`)) ? `origin/${base}` : base;
  if (!(await refExists(root, baseRef))) return false;
  return succeeds("git", ["merge-base", "--is-ancestor", branch, baseRef], { cwd: root });
}

/**
 * Teach the repository to ignore the per-session `.ccslack/` directory.
 *
 * Two things depend on this. `git worktree remove` refuses to delete a worktree
 * holding untracked files, so without it `ccslack clean` could never remove
 * anything; and Claude Code would otherwise see the prompt files as untracked
 * changes and might commit them.
 *
 * info/exclude lives in the common git dir, so one write covers every worktree
 * and never touches a tracked .gitignore the user's team shares.
 */
export async function ensureSessionDirIgnored(
  repoRoot: string,
  sessionDir: string,
): Promise<void> {
  const rule = `/${sessionDir}/`;
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
    });
    const excludeFile = join(stdout.trim(), "info", "exclude");

    const existing = await readFile(excludeFile, "utf8").catch(() => "");
    if (existing.split("\n").some((line) => line.trim() === rule)) return;

    await mkdir(dirname(excludeFile), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludeFile, `${separator}# ccslack session files\n${rule}\n`, "utf8");
    log.debug(`added ${rule} to ${excludeFile}`);
  } catch (err) {
    // Not fatal: sessions still work, `ccslack clean` just needs --force.
    log.warn(`could not add ${rule} to the repo's exclude file`, describe(err));
  }
}
