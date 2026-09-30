import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configSchema, type Config } from "../src/config/schema.js";
import { inspectRepo } from "../src/git/repo.js";
import { createWorktree, type Worktree } from "../src/git/worktree.js";
import {
  AutoCleaner,
  finishedWorktrees,
  sweepWorktrees,
  type SweepOutcome,
} from "../src/session/cleanup.js";

const exec = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let repoPath: string;
let worktreesRoot: string;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return stdout;
}

function configFor(settings: Record<string, unknown> = {}, repos: string[] = [repoPath]): Config {
  return configSchema.parse({
    settings: { worktreesRoot, fetchBeforeCreate: false, ...settings },
    channels: { eng: repos.map((p) => ({ repoPath: p, channel: "eng" })) },
  });
}

async function session(branch: string): Promise<Worktree> {
  return createWorktree({
    repo: await inspectRepo(repoPath),
    branch,
    baseBranch: "main",
    worktreesRoot,
    fetch: false,
  });
}

/** A session whose work has landed: one commit, fast-forwarded into main. */
async function mergedSession(branch: string): Promise<Worktree> {
  const w = await session(branch);
  await writeFile(join(w.path, `${branch.replace(/\//g, "-")}.txt`), "done\n");
  await git(["add", "."], w.path);
  await git(["commit", "-m", `work on ${branch}`], w.path);
  await git(["merge", "--ff-only", w.branch], repoPath);
  return w;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function branchExists(branch: string): Promise<boolean> {
  return exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath }).then(
    () => true,
    () => false,
  );
}

const kinds = (outcomes: SweepOutcome[]): Record<string, string> =>
  Object.fromEntries(outcomes.map((o) => ["branch" in o ? o.branch : o.repoPath, o.kind]));

beforeEach(async () => {
  // Real paths: git reports worktrees by them, and the sweep only touches
  // worktrees whose path starts with worktreesRoot.
  root = await realpath(await mkdtemp(join(tmpdir(), "sidequest-clean-")));
  repoPath = join(root, "repo");
  worktreesRoot = join(root, "worktrees");
  await mkdir(repoPath, { recursive: true });
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "# test\n");
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "initial"], repoPath);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("sweepWorktrees", () => {
  it("removes merged worktrees and their branches, and keeps unmerged and dirty ones", async () => {
    const merged = await mergedSession("fix/merged");

    const unmerged = await session("fix/unmerged");
    await writeFile(join(unmerged.path, "wip.txt"), "wip\n");
    await git(["add", "."], unmerged.path);
    await git(["commit", "-m", "wip"], unmerged.path);

    // Nothing committed, so the branch is "merged", but there is work on disk.
    const dirty = await session("fix/dirty");
    await writeFile(join(dirty.path, "notes.txt"), "half a thought\n");

    const outcomes = await sweepWorktrees(configFor());
    expect(kinds(outcomes)).toEqual({
      "fix/merged": "removed",
      "fix/unmerged": "not-merged",
      "fix/dirty": "dirty",
    });
    expect(await exists(merged.path)).toBe(false);
    expect(await branchExists("fix/merged")).toBe(false);
    expect(await exists(unmerged.path)).toBe(true);
    expect(await branchExists("fix/unmerged")).toBe(true);
    expect(await exists(join(dirty.path, "notes.txt"))).toBe(true);
  });

  it("keeps the branch when pruneBranchesOnClean is off", async () => {
    const w = await mergedSession("fix/keep-branch");
    const [outcome] = await sweepWorktrees(configFor({ pruneBranchesOnClean: false }));
    expect(outcome).toMatchObject({ kind: "removed", removedBranch: false });
    expect(await exists(w.path)).toBe(false);
    expect(await branchExists("fix/keep-branch")).toBe(true);
  });

  it("never touches a worktree outside worktreesRoot", async () => {
    const handmade = join(root, "elsewhere");
    await git(["worktree", "add", "-b", "mine", handmade, "main"], repoPath);
    expect(await sweepWorktrees(configFor())).toEqual([]);
    expect(await exists(handmade)).toBe(true);
  });

  it("leaves a merged worktree alone until it has been idle long enough", async () => {
    const w = await mergedSession("investigate/still-reading");
    const idle = 7 * DAY_MS;

    const now = await sweepWorktrees(configFor(), { minIdleMs: idle });
    expect(kinds(now)).toEqual({ "investigate/still-reading": "recent" });
    expect(await exists(w.path)).toBe(true);

    const later = await sweepWorktrees(configFor(), { minIdleMs: idle, now: () => Date.now() + idle + DAY_MS });
    expect(kinds(later)).toEqual({ "investigate/still-reading": "removed" });
    expect(await exists(w.path)).toBe(false);
  });

  it("removes nothing on a dry run", async () => {
    const w = await mergedSession("fix/dry");
    const outcomes = await sweepWorktrees(configFor(), { dryRun: true });
    expect(kinds(outcomes)).toEqual({ "fix/dry": "removed" });
    expect(await exists(w.path)).toBe(true);
    expect(await branchExists("fix/dry")).toBe(true);
  });

  it("carries on past a linked repo that has gone missing", async () => {
    const w = await mergedSession("fix/survivor");
    const gone = join(root, "moved-away");
    const outcomes = await sweepWorktrees(configFor({}, [gone, repoPath]));
    expect(kinds(outcomes)).toEqual({ [gone]: "repo-error", "fix/survivor": "removed" });
    expect(await exists(w.path)).toBe(false);
  });
});

describe("finishedWorktrees", () => {
  it("counts merged worktrees past autoCleanAfterDays, without removing them", async () => {
    const w = await mergedSession("fix/finished");
    await session("fix/unmerged-ish").then(async (u) => {
      await writeFile(join(u.path, "x.txt"), "x\n");
      await git(["add", "."], u.path);
      await git(["commit", "-m", "x"], u.path);
    });
    const config = configFor({ autoCleanAfterDays: 3 });

    expect(await finishedWorktrees(config)).toHaveLength(0);
    const later = await finishedWorktrees(config, () => Date.now() + 4 * DAY_MS);
    expect(later.map((o) => ("branch" in o ? o.branch : ""))).toEqual(["fix/finished"]);
    expect(await exists(w.path)).toBe(true);
  });
});

describe("AutoCleaner", () => {
  it("does nothing while autoClean is off", async () => {
    const w = await mergedSession("fix/off");
    const cleaner = new AutoCleaner({
      loadConfig: async () => configFor({ autoClean: false, autoCleanAfterDays: 0 }),
    });
    expect(await cleaner.runOnce()).toEqual([]);
    expect(await exists(w.path)).toBe(true);
  });

  it("removes merged, idle worktrees when on, by the same rules as clean", async () => {
    const merged = await mergedSession("fix/on");
    const dirty = await session("fix/on-dirty");
    await writeFile(join(dirty.path, "notes.txt"), "keep me\n");

    const cleaner = new AutoCleaner({
      loadConfig: async () => configFor({ autoClean: true, autoCleanAfterDays: 7 }),
      now: () => Date.now() + 8 * DAY_MS,
    });
    const outcomes = await cleaner.runOnce();
    expect(kinds(outcomes)).toEqual({ "fix/on": "removed", "fix/on-dirty": "dirty" });
    expect(await exists(merged.path)).toBe(false);
    expect(await exists(join(dirty.path, "notes.txt"))).toBe(true);
  });

  it("keeps a merged worktree that is still recent", async () => {
    const w = await mergedSession("fix/recent");
    const cleaner = new AutoCleaner({
      loadConfig: async () => configFor({ autoClean: true, autoCleanAfterDays: 7 }),
    });
    expect(kinds(await cleaner.runOnce())).toEqual({ "fix/recent": "recent" });
    expect(await exists(w.path)).toBe(true);
  });

  it("sweeps after the initial delay, then on every interval, until stopped", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const cleaner = new AutoCleaner({
      loadConfig: async () => {
        loads += 1;
        return configFor({ autoClean: false });
      },
      initialDelayMs: 1_000,
      intervalMs: 60_000,
    });
    cleaner.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(loads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(loads).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads).toBe(2);
    cleaner.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loads).toBe(2);
  });

  it("shares one sweep between overlapping calls", async () => {
    let loads = 0;
    const cleaner = new AutoCleaner({
      loadConfig: async () => {
        loads += 1;
        return configFor({ autoClean: false });
      },
    });
    await Promise.all([cleaner.runOnce(), cleaner.runOnce()]);
    expect(loads).toBe(1);
  });
});
