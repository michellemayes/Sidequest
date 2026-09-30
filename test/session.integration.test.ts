import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectRepo } from "../src/git/repo.js";
import { createWorktree, listWorktrees, removeWorktree } from "../src/git/worktree.js";
import { writeAutorun, autorunPaths } from "../src/warp/autorun.js";
import { writeLaunchConfig, writeTabConfig } from "../src/warp/configFiles.js";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);

let root: string;
let repoPath: string;

async function git(args: string[], cwd: string): Promise<void> {
  await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-test-"));
  repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });

  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "# test\n");
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "initial"], repoPath);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("inspectRepo", () => {
  it("resolves the repo root from a subdirectory", async () => {
    const nested = join(repoPath, "src", "deep");
    await mkdir(nested, { recursive: true });
    const info = await inspectRepo(nested);
    expect(info.root).toBe(await realish(repoPath));
    expect(info.defaultBranch).toBe("main");
    expect(info.hasRemote).toBe(false);
  });

  it("rejects a directory that is not a git repo", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    await expect(inspectRepo(plain)).rejects.toThrow(/not inside a git repository/);
  });

  it("rejects a repo with no commits", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    await git(["init", "--initial-branch=main"], empty);
    await expect(inspectRepo(empty)).rejects.toThrow(/no commits/);
  });
});

describe("createWorktree", () => {
  it("creates a branch and a checked-out worktree", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/thing-20260909-1432",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    expect(worktree.branch).toBe("fix/thing-20260909-1432");
    // The slash becomes a dash so the worktree is one flat directory.
    expect(worktree.path).toBe(join(root, "worktrees", "fix-thing-20260909-1432"));
    await expect(stat(join(worktree.path, "README.md"))).resolves.toBeTruthy();

    const listed = await listWorktrees(repo.root);
    expect(listed.map((w) => w.branch)).toContain("fix/thing-20260909-1432");
  });

  it("suffixes branch and directory together when a name is taken", async () => {
    const repo = await inspectRepo(repoPath);
    const options = {
      repo,
      branch: "fix/dup",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    };

    const first = await createWorktree(options);
    const second = await createWorktree(options);

    expect(first.branch).toBe("fix/dup");
    expect(second.branch).toBe("fix/dup-2");
    expect(second.path.endsWith("fix-dup-2")).toBe(true);
  });

  it("cuts from the fetched base when the fetch is quick", async () => {
    const remote = join(root, "remote.git");
    await git(["clone", "--bare", repoPath, remote], root);
    await git(["remote", "add", "origin", remote], repoPath);
    await git(["fetch", "origin"], repoPath);

    // Someone else pushes a commit the local checkout has not seen.
    const other = join(root, "other");
    await git(["clone", remote, other], root);
    await writeFile(join(other, "NEW.md"), "new\n");
    await git(["add", "."], other);
    await git(["commit", "-m", "upstream"], other);
    await git(["push", "origin", "main"], other);

    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/fresh",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: true,
    });
    expect(worktree.baseRef).toBe("origin/main");
    await expect(stat(join(worktree.path, "NEW.md"))).resolves.toBeTruthy();
  });

  it("runs the caller's work alongside the checkout with the final names", async () => {
    const repo = await inspectRepo(repoPath);
    const seen: Array<{ branch: string; path: string }> = [];
    const worktree = await createWorktree({
      repo,
      branch: "fix/alongside",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
      alongsideCheckout: async (names) => {
        seen.push(names);
      },
    });
    expect(seen).toEqual([{ branch: worktree.branch, path: worktree.path }]);
  });

  it("fails clearly when the base branch does not exist", async () => {
    const repo = await inspectRepo(repoPath);
    await expect(
      createWorktree({
        repo,
        branch: "fix/x",
        baseBranch: "nonexistent",
        worktreesRoot: join(root, "worktrees"),
        fetch: false,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("session directory is ignored", () => {
  it("keeps .sidequest out of git status and lets the worktree be removed", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/ignored",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    await writeAutorun({
      worktreePath: worktree.path,
      prompt: "hello",
      agentCommand: "true",
      agentArgs: [],
    });

    // Claude Code must not see the prompt files as untracked work.
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktree.path });
    expect(stdout.trim()).toBe("");

    // And `git worktree remove` must not refuse over them, or `sidequest clean`
    // could never remove a session without --force.
    const result = await removeWorktree(repo.root, worktree.path, {});
    expect(result.removedWorktree).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree but keeps a branch holding unmerged work", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/unmerged",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    await writeFile(join(worktree.path, "new.txt"), "work\n");
    await git(["add", "."], worktree.path);
    await git(["commit", "-m", "wip"], worktree.path);

    const result = await removeWorktree(repo.root, worktree.path, {
      deleteBranch: worktree.branch,
    });

    expect(result.removedWorktree).toBe(true);
    // git branch -d refuses, which is exactly the protection we want.
    expect(result.removedBranch).toBe(false);
  });
});

describe("autorun script", () => {
  it("runs the claude command exactly once, even if invoked twice", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/autorun",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    const receipt = join(root, "receipt.txt");
    const stub = await writeStubClaude(root, receipt);

    const prompt = "Fix the thing.\nIt's broken; $(whoami) & `id` should stay literal.";
    const files = await writeAutorun({
      worktreePath: worktree.path,
      prompt,
      agentCommand: stub,
      agentArgs: ["--model", "opus"],
    });

    await exec("bash", [files.scriptFile]);
    await exec("bash", [files.scriptFile]);

    const recorded = await readFile(receipt, "utf8");
    const runs = recorded.split("---RUN---").filter((s) => s.trim().length > 0);
    expect(runs).toHaveLength(1);

    // Flags come through as separate argv entries, the prompt as one argument
    // with its shell metacharacters intact rather than expanded.
    expect(runs[0]).toContain("--model\nopus\n");
    expect(runs[0]).toContain("$(whoami)");
    expect(runs[0]).toContain("`id`");
    expect(runs[0]).not.toContain("uid=");
  });

  it("sets the starting tab title, which the agent can replace later", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/title",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    const receipt = join(root, "receipt.txt");
    const stub = await writeStubClaude(root, receipt);
    const files = await writeAutorun({
      worktreePath: worktree.path,
      prompt: "Fix it.",
      agentCommand: stub,
      agentArgs: [],
      title: "Ask · it's $(id)\u0007",
    });

    const { stdout } = await exec("bash", [files.scriptFile]);
    expect(stdout).toBe("\u001b]0;Ask · it's $(id)\u0007");
  });

  it("claims the pending marker so a second run is a no-op", async () => {
    const repo = await inspectRepo(repoPath);
    const worktree = await createWorktree({
      repo,
      branch: "fix/marker",
      baseBranch: "main",
      worktreesRoot: join(root, "worktrees"),
      fetch: false,
    });

    const files = await writeAutorun({
      worktreePath: worktree.path,
      prompt: "hi",
      agentCommand: await writeStubClaude(root, join(root, "r2.txt")),
      agentArgs: [],
    });

    await expect(stat(files.pendingFile)).resolves.toBeTruthy();
    await exec("bash", [files.scriptFile]);
    await expect(stat(files.pendingFile)).rejects.toThrow();
    await expect(stat(join(autorunPaths(worktree.path).dir, "started"))).resolves.toBeTruthy();
  });
});

describe("writeLaunchConfig", () => {
  it("writes YAML whose name matches the filename the deeplink uses", async () => {
    const dir = join(root, "warp");
    process.env.XDG_DATA_HOME = dir;
    const previousPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const name = await writeLaunchConfig(
        {
          name: "sidequest-fix-thing",
          color: "yellow",
          cwd: "/tmp/wt",
          command: "/tmp/wt/.sidequest/autorun.sh",
        },
        false,
      );

      const file = join(dir, "warp-terminal", "launch_configurations", `${name}.yaml`);
      const doc = parseYaml(await readFile(file, "utf8"));

      expect(doc.name).toBe("sidequest-fix-thing");
      // A config title pins the tab, so the running agent could never retitle it.
      expect(doc.windows[0].tabs[0]).not.toHaveProperty("title");
      expect(doc.windows[0].tabs[0].color).toBe("Yellow");
      expect(doc.windows[0].tabs[0].layout.cwd).toBe("/tmp/wt");
      expect(doc.windows[0].tabs[0].layout.commands[0].exec).toBe("'/tmp/wt/.sidequest/autorun.sh'");
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform });
      delete process.env.XDG_DATA_HOME;
    }
  });
});

describe("writeTabConfig", () => {
  it("leaves the title to the terminal so the agent can retitle the tab", async () => {
    const dir = join(root, "warp");
    process.env.XDG_DATA_HOME = dir;
    const previousPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const name = await writeTabConfig(
        {
          name: "sidequest-fix-thing",
          color: "yellow",
          cwd: "/tmp/wt",
          command: "/tmp/wt/.sidequest/autorun.sh",
        },
        false,
      );

      const toml = await readFile(join(dir, "warp-terminal", "tab_configs", `${name}.toml`), "utf8");
      expect(toml).toContain('name = "sidequest-fix-thing"');
      expect(toml).toContain('color = "yellow"');
      expect(toml).not.toMatch(/^title\s*=/m);
    } finally {
      Object.defineProperty(process, "platform", { value: previousPlatform });
      delete process.env.XDG_DATA_HOME;
    }
  });
});

/** A stand-in for `claude` that records its argv and exits. */
async function writeStubClaude(dir: string, receipt: string): Promise<string> {
  const path = join(dir, "stub-claude.sh");
  await writeFile(
    path,
    ["#!/usr/bin/env bash", `printf -- '---RUN---\\n' >> ${JSON.stringify(receipt)}`, `printf '%s\\n' "$@" >> ${JSON.stringify(receipt)}`, ""].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

/** macOS temp dirs are symlinks, so compare against git's resolved path. */
async function realish(path: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path });
  return stdout.trim();
}
