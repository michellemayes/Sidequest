import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectRepo } from "../src/git/repo.js";
import { createWorktree, listWorktrees } from "../src/git/worktree.js";
import { writeAutorun } from "../src/warp/autorun.js";
import { configSchema, type Config } from "../src/config/schema.js";
import type { HistoryEntry } from "../src/session/history.js";
import {
  UncommittedWorkError,
  findById,
  listSessions,
  removeSession,
} from "../src/session/sessions.js";

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let root: string;
let repoPath: string;
let worktreesRoot: string;
let config: Config;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: ENV });
  return stdout;
}

/** A real session: a worktree cut from main, and the history entry for it. */
async function session(branch: string, minutesAgo = 0): Promise<HistoryEntry> {
  const repo = await inspectRepo(repoPath);
  const wt = await createWorktree({ repo, branch, baseBranch: "main", worktreesRoot, fetch: false });
  return {
    ts: `1757430000.${String(minutesAgo).padStart(6, "0")}`,
    channel: "eng-alerts",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: wt.branch,
    worktreePath: wt.path,
    repoPath: repo.root,
    repoLabel: "repo",
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-sessions-"));
  repoPath = join(root, "repo");
  worktreesRoot = join(root, "worktrees");
  await mkdir(repoPath, { recursive: true });
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "# test\n");
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "initial"], repoPath);
  config = configSchema.parse({
    settings: { worktreesRoot },
    channels: { "eng-alerts": { repoPath, channel: "eng-alerts" } },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listSessions", () => {
  it("lists live sessions newest first, with what git says about each", async () => {
    const older = await session("fix/older", 90);
    const newer = await session("fix/newer", 5);

    // The older one has a commit of its own and a file not yet committed.
    await writeFile(join(older.worktreePath, "fix.txt"), "fixed\n");
    await git(["add", "fix.txt"], older.worktreePath);
    await git(["commit", "-m", "fix"], older.worktreePath);
    await writeFile(join(older.worktreePath, "wip.txt"), "wip\n");
    // The newer one's agent has not picked it up yet.
    await writeAutorun({ worktreePath: newer.worktreePath, prompt: "p", agentCommand: "true", agentArgs: [] });

    const list = await listSessions(config, [older, newer]);
    expect(list.map((s) => s.branch)).toEqual(["fix/newer", "fix/older"]);
    expect(list[0]).toMatchObject({
      id: basename(newer.worktreePath),
      repo: "repo",
      channel: "eng-alerts",
      promptLabel: "Fix",
      state: "active",
      ahead: 0,
      // The session's own .sidequest/ is excluded from git, so it is not dirt.
      dirty: 0,
      pending: true,
    });
    expect(list[1]).toMatchObject({ state: "active", ahead: 1, dirty: 1, pending: false });
    // Paths stay with the daemon.
    expect(JSON.stringify(list)).not.toContain(root);
  });

  it("leaves out cleaned-up sessions, shows deleted ones as gone, and caps the list", async () => {
    const cleaned = await session("fix/cleaned", 30);
    const deleted = await session("fix/deleted", 20);
    const live = await Promise.all([1, 2, 3].map((n) => session(`fix/live-${n}`, 10 - n)));

    await git(["worktree", "remove", cleaned.worktreePath], repoPath);
    await rm(deleted.worktreePath, { recursive: true, force: true });

    const all = await listSessions(config, [cleaned, deleted, ...live]);
    expect(all.map((s) => [s.branch, s.state])).toEqual([
      ["fix/live-3", "active"],
      ["fix/live-2", "active"],
      ["fix/live-1", "active"],
      ["fix/deleted", "gone"],
    ]);
    expect((await listSessions(config, [cleaned, deleted, ...live], 2)).map((s) => s.branch))
      .toEqual(["fix/live-3", "fix/live-2"]);
  });

  it("lists a session once however many times history has it", async () => {
    const entry = await session("fix/twice");
    const list = await listSessions(config, [entry, { ...entry, createdAt: new Date().toISOString() }]);
    expect(list).toHaveLength(1);
  });
});

describe("removeSession", () => {
  it("removes a clean worktree and deletes a branch with nothing unmerged", async () => {
    const entry = await session("fix/done");
    const result = await removeSession(config, [entry], basename(entry.worktreePath));
    expect(result).toEqual({ branch: "fix/done", removedWorktree: true, removedBranch: true });
    expect(await exists(entry.worktreePath)).toBe(false);
    expect(await git(["branch", "--list", "fix/done"], repoPath)).toBe("");
  });

  it("keeps a branch that has commits its base does not", async () => {
    const entry = await session("fix/unmerged");
    await writeFile(join(entry.worktreePath, "fix.txt"), "fixed\n");
    await git(["add", "fix.txt"], entry.worktreePath);
    await git(["commit", "-m", "fix"], entry.worktreePath);

    const result = await removeSession(config, [entry], basename(entry.worktreePath));
    expect(result).toMatchObject({ removedWorktree: true, removedBranch: false });
    expect(await git(["branch", "--list", "fix/unmerged"], repoPath)).toContain("fix/unmerged");
  });

  it("refuses uncommitted work unless forced, and says how much there is", async () => {
    const entry = await session("fix/wip");
    await writeFile(join(entry.worktreePath, "README.md"), "# changed\n");
    await writeFile(join(entry.worktreePath, "new.txt"), "new\n");
    const id = basename(entry.worktreePath);

    const refused = await removeSession(config, [entry], id).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UncommittedWorkError);
    expect((refused as UncommittedWorkError).dirty).toBe(2);
    expect(await exists(join(entry.worktreePath, "new.txt"))).toBe(true);

    const forced = await removeSession(config, [entry], id, { force: true });
    expect(forced.removedWorktree).toBe(true);
    expect(await exists(entry.worktreePath)).toBe(false);
  });

  it("drops what git still keeps of a worktree deleted by hand", async () => {
    const entry = await session("fix/deleted");
    await rm(entry.worktreePath, { recursive: true, force: true });
    const result = await removeSession(config, [entry], basename(entry.worktreePath));
    expect(result.removedWorktree).toBe(true);
    const left = await listWorktrees(repoPath);
    expect(left.some((w) => w.branch === "fix/deleted")).toBe(false);
  });

  it("honours pruneBranchesOnClean: off keeps even a merged branch", async () => {
    const entry = await session("fix/keep");
    config.settings.pruneBranchesOnClean = false;
    const result = await removeSession(config, [entry], basename(entry.worktreePath));
    expect(result).toMatchObject({ removedWorktree: true, removedBranch: false });
  });
});

describe("findById", () => {
  it("finds only a plain directory name under worktreesRoot", async () => {
    const entry = await session("fix/found");
    const id = basename(entry.worktreePath);
    expect((await findById(config, [entry], id))?.worktree.branch).toBe("fix/found");
    for (const bad of ["", ".", "..", "../repo", `${id}/..`, entry.worktreePath]) {
      expect(await findById(config, [entry], bad)).toBeNull();
    }
  });
});
