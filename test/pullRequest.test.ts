import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openPullRequest, pullRequestUrl } from "../src/session/pullRequest.js";
import type { HistoryEntry } from "../src/session/history.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const git = (args: string[], cwd: string) => exec("git", args, { cwd, env: GIT_ENV });

let root: string;
let worktree: string;
let entry: HistoryEntry;
const OLD_PATH = process.env.PATH;

/** A stand-in for gh that records its arguments and answers as told. */
async function fakeGh(script: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash\necho "$@" > "${join(root, "gh-args")}"\n${script}\n`);
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${OLD_PATH}`;
  return join(root, "gh-args");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-pr-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
  await mkdir(repo);
  await git(["init", "--initial-branch=main"], repo);
  await writeFile(join(repo, "README.md"), "# x\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "initial"], repo);
  await git(["remote", "add", "origin", origin], repo);
  await git(["push", "-u", "origin", "main"], repo);
  worktree = join(root, "wt");
  await git(["worktree", "add", "-b", "fix/gift-cards", worktree, "origin/main"], repo);
  entry = {
    ts: "1.2",
    channel: "storefront-escalations",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: "fix/gift-cards",
    worktreePath: worktree,
    repoPath: repo,
    repoLabel: "repo",
    createdAt: new Date().toISOString(),
    baseBranch: "main",
    agentLabel: "Claude Code",
  };
});

afterEach(async () => {
  process.env.PATH = OLD_PATH;
  await rm(root, { recursive: true, force: true });
});

describe("opening a session's pull request", () => {
  it("refuses a branch with nothing committed, and pushes nothing", async () => {
    await fakeGh("exit 1");
    await expect(openPullRequest(entry)).rejects.toThrow(/nothing committed/);
    const { stdout } = await git(["ls-remote", "origin"], worktree);
    expect(stdout).not.toContain("fix/gift-cards");
  });

  it("pushes the branch and opens a draft titled for its first commit, described by the agent's reply", async () => {
    await writeFile(join(worktree, "a.txt"), "a");
    await git(["add", "."], worktree);
    await git(["commit", "-m", "Fix gift card totals"], worktree);
    await writeFile(join(worktree, "b.txt"), "b");
    await git(["add", "."], worktree);
    await git(["commit", "-m", "Add a test"], worktree);
    await mkdir(join(worktree, ".sidequest"), { recursive: true });
    await writeFile(join(worktree, ".sidequest", "result.md"), "Gift cards were taxed twice. Fixed in `total()`.");
    const argsFile = await fakeGh('echo "https://github.com/o/r/pull/77"');

    expect(await openPullRequest(entry)).toEqual({ url: "https://github.com/o/r/pull/77", created: true });
    const { stdout } = await git(["ls-remote", "origin"], worktree);
    expect(stdout).toContain("refs/heads/fix/gift-cards");
    const args = await readFile(argsFile, "utf8");
    expect(args).toContain("pr create --draft --head fix/gift-cards --base main --title Fix gift card totals --body-file");
    const body = await readFile(join(worktree, ".sidequest", "pr-body.md"), "utf8");
    expect(body).toContain("Gift cards were taxed twice.");
    expect(body).toContain("worked by Claude Code");
    // A private workspace's names stay out of what may be a public repo.
    expect(body).not.toContain("storefront-escalations");
  });

  it("hands back the pull request a branch already has rather than failing", async () => {
    await writeFile(join(worktree, "a.txt"), "a");
    await git(["add", "."], worktree);
    await git(["commit", "-m", "Fix it"], worktree);
    await fakeGh('echo \'a pull request for branch "fix/gift-cards" into branch "main" already exists:\' >&2; echo "https://github.com/o/r/pull/5" >&2; exit 1');
    expect(await openPullRequest(entry)).toEqual({ url: "https://github.com/o/r/pull/5", created: false });
  });

  it("finds the URL in what gh prints", () => {
    expect(pullRequestUrl("Creating draft pull request\n\nhttps://github.com/o/r/pull/12\n")).toBe("https://github.com/o/r/pull/12");
    expect(pullRequestUrl("nothing here")).toBeNull();
  });
});
