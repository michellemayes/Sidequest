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
      "Install git and restart Sidequest.",
    );
  }
}

/**
 * Resolve a user-supplied path to the top level of its git repository.
 * Accepts any directory inside the repo, not just the root.
 */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  const found = await locateRepo(path);
  return { ...found, defaultBranch: await detectDefaultBranch(found.root, found.hasRemote) };
}

/** What inspectRepo finds short of the default branch, which takes its own probes. */
export type RepoLocation = Omit<RepoInfo, "defaultBranch">;

async function locateRepo(path: string): Promise<RepoLocation> {
  await assertDirectory(path);

  let root: string;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: path });
    root = stdout.trim();
  } catch (err) {
    if (err instanceof CommandError) {
      throw new UserFacingError(
        `${path} is not inside a git repository.`,
        "Point Sidequest at a git checkout, or run `git init` there first.",
      );
    }
    throw err;
  }

  // Independent probes, so they run side by side: each is a process spawn.
  const [hasCommits, remotes] = await Promise.all([
    succeeds("git", ["rev-parse", "HEAD"], { cwd: root }),
    run("git", ["remote"], { cwd: root }),
  ]);
  // A repo with no commits has no branch to cut a worktree from.
  if (!hasCommits) {
    throw new UserFacingError(
      `${root} has no commits yet.`,
      "Make at least one commit before linking the repo.",
    );
  }

  return { root, name: basename(root), hasRemote: remotes.stdout.trim().length > 0 };
}

/**
 * The daemon looks the same repo up on every click, and the answer barely
 * changes, so it keeps it a while. Not for long: a repo that gains a remote
 * or has its default branch renamed should be noticed without a restart.
 */
const REPO_CACHE_MS = 5 * 60_000;

interface Cached<T> {
  value: Promise<T>;
  at: number;
}

const located = new Map<string, Cached<RepoLocation>>();
const defaultBranches = new Map<string, Cached<string>>();

function remembered<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < REPO_CACHE_MS) return hit.value;
  // The promise itself is kept, so a prefetch and a click arriving together
  // share one lookup. A failure is not kept: the next try asks git again.
  const value = load();
  const entry = { value, at: Date.now() };
  cache.set(key, entry);
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}

/** The repo at a path, as inspectRepo finds it bar the default branch, remembered a few minutes. */
export async function locateRepoCached(path: string): Promise<RepoLocation> {
  // Checked every time, since it costs nothing: a repo moved or deleted
  // since it was remembered gets the same error it always did.
  await assertDirectory(path);
  return remembered(located, path, () => locateRepo(path));
}

async function assertDirectory(path: string): Promise<void> {
  let entry;
  try {
    entry = await stat(path);
  } catch {
    throw new UserFacingError(`No such directory: ${path}`);
  }
  if (!entry.isDirectory()) {
    throw new UserFacingError(`Not a directory: ${path}`);
  }
}

/** detectDefaultBranch, remembered a few minutes per repo. */
export function defaultBranchCached(repo: RepoLocation): Promise<string> {
  return remembered(defaultBranches, repo.root, () => detectDefaultBranch(repo.root, repo.hasRemote));
}

/**
 * Drop what is remembered about repos, after a link changes or git fails in
 * one, so the next click looks again rather than trusting a stale answer.
 */
export function forgetRepos(): void {
  located.clear();
  defaultBranches.clear();
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

  const candidates = ["main", "master", "develop", "trunk"];
  const found = await Promise.all(candidates.map((candidate) => branchExists(root, candidate)));
  const conventional = candidates.find((_, i) => found[i]);
  if (conventional) return conventional;

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
    "Set a different base with `sidequest link <repo> --base <branch>`.",
  );
}

/**
 * Best-effort fetch. A network failure must not block creating the session,
 * so this never throws; it says whether the fetch worked.
 */
export async function fetchQuietly(root: string, baseBranch: string): Promise<boolean> {
  try {
    // Only the base branch matters here; skipping tags saves a round of ref negotiation.
    await run("git", ["fetch", "--quiet", "--no-tags", "origin", baseBranch], { cwd: root, timeoutMs: 45_000 });
    return true;
  } catch (err) {
    log.warn(`could not fetch origin/${baseBranch}; using the local ref instead`, describe(err));
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when every commit on `branch` is already contained in `base`, i.e. the
 * branch has nothing left to lose. Used to decide what `sidequest clean` may
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
 * Teach the repository to ignore the per-session `.sidequest/` directory.
 *
 * Two things depend on this. `git worktree remove` refuses to delete a worktree
 * holding untracked files, so without it `sidequest clean` could never remove
 * anything; and the agent would otherwise see the prompt files as untracked
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
  const key = `${repoRoot}\0${rule}`;
  // Once a repo has the rule, it keeps it; later sessions skip the git call.
  if (ignoredAlready.has(key)) return;
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
    });
    const excludeFile = join(stdout.trim(), "info", "exclude");

    const existing = await readFile(excludeFile, "utf8").catch(() => "");
    if (existing.split("\n").some((line) => line.trim() === rule)) {
      ignoredAlready.add(key);
      return;
    }

    await mkdir(dirname(excludeFile), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludeFile, `${separator}# sidequest session files\n${rule}\n`, "utf8");
    ignoredAlready.add(key);
    log.debug(`added ${rule} to ${excludeFile}`);
  } catch (err) {
    // Not fatal: sessions still work, `sidequest clean` just needs --force.
    log.warn(`could not add ${rule} to the repo's exclude file`, describe(err));
  }
}

/** Repos (and rules) already known to carry the exclude rule, this process. */
const ignoredAlready = new Set<string>();
