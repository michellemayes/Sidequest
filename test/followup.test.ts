import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configSchema } from "../src/config/schema.js";
import { allPrompts, promptFor } from "../src/config/store.js";
import { pageConfig } from "../src/config/pageConfig.js";
import {
  formatAttachments,
  MAX_ATTACHMENTS,
  safeFileName,
  saveAttachments,
} from "../src/session/attachments.js";
import { MAX_RESULT_CHARS, resultInstructions, resultReply, toSlack } from "../src/session/result.js";
import { parsePullRequest, StatusWatcher, type SessionStatus } from "../src/session/status.js";
import { loadHistory, recordSession, updateSession, type HistoryEntry } from "../src/session/history.js";

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-followup-"));
  process.env.SIDEQUEST_HOME = join(root, "home");
});

afterEach(async () => {
  delete process.env.SIDEQUEST_HOME;
  await rm(root, { recursive: true, force: true });
});

describe("custom prompts", () => {
  const config = (prompts: unknown) => configSchema.parse({ prompts });

  it("adds prompts of your own after the built-ins, in config order", () => {
    const c = config({
      "write-test": { label: "Write a test", template: "Test {{message}}", emoji: "test_tube" },
      triage: { label: "Triage", template: "Triage {{message}}" },
    });
    const keys = allPrompts(c).map((p) => p.key);
    expect(keys.slice(-2)).toEqual(["write-test", "triage"]);
    expect(keys.indexOf("fix")).toBeLessThan(keys.indexOf("write-test"));
    // Named for its key unless it says otherwise, and silent in Slack.
    expect(promptFor(c, "write-test")).toMatchObject({ branchPrefix: "write-test", reply: "", emoji: "test_tube" });
  });

  it("hides a prompt, built-in or not, without forgetting it", () => {
    const c = config({ review: { hidden: true }, triage: { label: "Triage", template: "x", hidden: true } });
    const keys = allPrompts(c).map((p) => p.key);
    expect(keys).not.toContain("review");
    expect(keys).not.toContain("triage");
    // Still a prompt: a session already on its way is not refused.
    expect(promptFor(c, "review")?.label).toBe("Review");
  });

  it("insists a prompt of your own has a label, a template and a usable key", () => {
    expect(configSchema.safeParse({ prompts: { triage: { label: "Triage" } } }).success).toBe(false);
    expect(configSchema.safeParse({ prompts: { "Not OK": { label: "x", template: "y" } } }).success).toBe(false);
    // A built-in override needs neither.
    expect(configSchema.safeParse({ prompts: { fix: { label: "Patch" } } }).success).toBe(true);
  });

  it("knows no prompt it was not given", () => {
    const c = config({});
    expect(promptFor(c, "nope")).toBeNull();
    expect(promptFor(c, "constructor")).toBeNull();
  });

  it("tells the page about them", () => {
    const c = config({ triage: { label: "Triage", template: "x", emoji: "bug" } });
    expect(pageConfig(c).prompts).toContainEqual({ key: "triage", label: "Triage", emoji: "bug" });
  });
});

describe("result replies", () => {
  it("turns an agent's Markdown into Slack's markup", () => {
    const md = [
      "## Root cause",
      "The **cart total** used the *pre-discount* price, see [the PR](https://github.com/a/b/pull/1).",
      "- fixed `total()` for a <b> & c",
      "~~old~~",
      "```ts",
      "const a = x < y && **b**;",
      "```",
    ].join("\n");
    expect(toSlack(md)).toBe([
      "*Root cause*",
      "The *cart total* used the _pre-discount_ price, see <https://github.com/a/b/pull/1|the PR>.",
      "• fixed `total()` for a &lt;b&gt; &amp; c",
      "~old~",
      "```",
      "const a = x &lt; y &amp;&amp; **b**;",
      "```",
    ].join("\n"));
  });

  it("keeps a long reply thread-sized and says where the rest is", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of a very long write-up`).join("\n");
    const out = resultReply(long);
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(out).toMatch(/The full write-up is in the session\._$/);
  });

  it("closes a code block the cut left open", () => {
    const long = `\`\`\`\n${"x = 1\n".repeat(1000)}\`\`\``;
    const fences = resultReply(long).match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });

  it("adds the pull request unless the agent already linked it", () => {
    const pr = "https://github.com/a/b/pull/7";
    expect(resultReply("Fixed it.", { prUrl: pr })).toBe(`Fixed it.\n\nPull request: ${pr}`);
    expect(resultReply(`Fixed it in ${pr}.`, { prUrl: pr })).not.toContain("Pull request:");
  });

  it("signs the reply with the agent that wrote it", () => {
    expect(resultReply("Fixed it.", { agent: "Codex" }))
      .toBe("Fixed it.\n\n_🤖 Written by Codex, an AI agent, via Sidequest_");
    expect(resultReply("Fixed it.", { prUrl: "https://github.com/a/b/pull/7", agent: "Claude Code" }))
      .toMatch(/pull\/7\n\n_🤖 Written by Claude Code/);
  });

  it("asks the agent for a reply unless results are off", () => {
    expect(resultInstructions("off")).toBe("");
    expect(resultInstructions("ask")).toContain(".sidequest/result.md");
    expect(resultInstructions("ask")).toContain("offers it to me");
    expect(resultInstructions("auto")).toContain("as soon as you write it");
  });
});

describe("attachments", () => {
  it("makes a name safe to write", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("Screen Shot 2026-09-30 at 2.14.03 PM.png")).toBe("Screen-Shot-2026-09-30-at-2.14.03-PM.png");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName("", "fallback")).toBe("fallback");
  });

  it("saves the files into the session directory and lists them for the prompt", async () => {
    const worktree = join(root, "wt");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const saved = await saveAttachments(worktree, [
      { name: "shot.png", type: "image/png", data: png },
      { name: "shot.png", type: "image/png", data: png },
      { name: "empty.txt", type: "text/plain", data: "" },
    ]);
    expect(saved.map((f) => f.path)).toEqual([
      ".sidequest/attachments/shot.png",
      ".sidequest/attachments/shot-2.png",
    ]);
    expect(await readFile(join(worktree, saved[1]!.path))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const section = formatAttachments(saved);
    expect(section).toContain("### Attachments");
    expect(section).toContain("- .sidequest/attachments/shot.png (image/png, 4 B)");
    expect(formatAttachments([])).toBe("");
  });

  it("takes no more files than the limit", async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => ({
      name: `f${i}.txt`,
      type: "text/plain",
      data: Buffer.from(`file ${i}`).toString("base64"),
    }));
    expect(await saveAttachments(join(root, "wt"), files)).toHaveLength(MAX_ATTACHMENTS);
  });
});

describe("history updates", () => {
  it("changes one session in place and keeps the rest", async () => {
    const base = {
      ts: "1.1", channel: "c", promptKey: "fix", promptLabel: "Fix",
      worktreePath: "/w", repoPath: "/r", repoLabel: "r", createdAt: new Date().toISOString(),
    };
    await recordSession({ ...base, branch: "fix/a" });
    await recordSession({ ...base, branch: "fix/b" });
    await updateSession("fix/a", { resultPostedMs: 1234 });
    const history = await loadHistory();
    expect(history.map((h) => [h.branch, h.resultPostedMs])).toEqual([["fix/a", 1234], ["fix/b", undefined]]);
  });
});

describe("parsePullRequest", () => {
  it("reads gh's JSON", () => {
    expect(parsePullRequest('{"number":7,"url":"https://x/7","state":"MERGED"}')).toEqual({
      number: 7, url: "https://x/7", state: "MERGED",
    });
    expect(parsePullRequest("not json")).toBeNull();
    expect(parsePullRequest("{}")).toBeNull();
  });
});

describe("StatusWatcher", () => {
  let repoPath: string;
  let worktree: string;
  let entry: HistoryEntry;
  let now: number;

  beforeEach(async () => {
    repoPath = join(root, "repo");
    await mkdir(repoPath, { recursive: true });
    await git(["init", "--initial-branch=main"], repoPath);
    await writeFile(join(repoPath, "README.md"), "# test\n");
    await git(["add", "."], repoPath);
    await git(["commit", "-m", "initial"], repoPath);
    worktree = join(root, "wt");
    await git(["worktree", "add", "-b", "fix/thing", worktree, "main"], repoPath);
    now = Date.now();
    entry = {
      ts: "1.1", channel: "c", promptKey: "fix", promptLabel: "Fix", branch: "fix/thing",
      worktreePath: worktree, repoPath, repoLabel: "repo", createdAt: new Date(now).toISOString(),
      baseBranch: "main",
    };
  });

  const watcher = (history: () => HistoryEntry[], seen: Array<Map<string, SessionStatus>> = []) =>
    new StatusWatcher({
      history: async () => history(),
      pullRequests: false,
      now: () => now,
      onChange: (s) => seen.push(s),
    });

  it("follows a session from working to committed", async () => {
    const seen: Array<Map<string, SessionStatus>> = [];
    const w = watcher(() => [entry], seen);
    await w.refresh();
    expect(w.snapshot().get("fix/thing")).toMatchObject({ state: "working", commits: 0, dirty: false });

    await writeFile(join(worktree, "fix.txt"), "fixed\n");
    await w.refresh();
    expect(w.snapshot().get("fix/thing")).toMatchObject({ state: "working", dirty: true });

    await git(["add", "fix.txt"], worktree);
    await git(["commit", "-m", "fix"], worktree);
    await w.refresh();
    expect(w.snapshot().get("fix/thing")).toMatchObject({ state: "committed", commits: 1, dirty: false });
    // Told about each change, and only about changes.
    await w.refresh();
    expect(seen).toHaveLength(3);
  });

  it("offers a reply once it has settled, and not again once posted", async () => {
    const history = [entry];
    const w = watcher(() => history);
    await mkdir(join(worktree, ".sidequest"), { recursive: true });
    await writeFile(join(worktree, ".sidequest", "result.md"), "Found it.\n");
    const written = Math.floor(now / 1000);
    await utimes(join(worktree, ".sidequest", "result.md"), written, written);

    now = written * 1000 + 1000;
    await w.refresh();
    // Still being written, as far as anyone can tell.
    expect(w.snapshot().get("fix/thing")).toMatchObject({ state: "answered", resultPending: false });

    now = written * 1000 + 5000;
    await w.refresh();
    const status = w.snapshot().get("fix/thing")!;
    expect(status.resultPending).toBe(true);

    history[0] = { ...entry, resultPostedMs: status.resultMs! };
    await w.refresh();
    expect(w.snapshot().get("fix/thing")!.resultPending).toBe(false);
  });

  it("says when the worktree is gone, and stops looking", async () => {
    const w = watcher(() => [entry]);
    await git(["worktree", "remove", worktree], repoPath);
    await w.refresh();
    expect(w.snapshot().get("fix/thing")!.state).toBe("gone");
  });

  /*
   * A plain `git status` refreshes a stale index and writes it back under
   * index.lock; done every few seconds in the agent's worktree, that is a
   * lock its own `git commit` can trip over.
   */
  it("looks without taking the worktree's index lock", async () => {
    const later = Math.floor(Date.now() / 1000) + 60;
    // Same content, newer mtime: the index entry is stale and a locking
    // status would rewrite it.
    await utimes(join(worktree, "README.md"), later, later);
    const index = join(repoPath, ".git", "worktrees", "wt", "index");
    const before = (await stat(index)).mtimeMs;

    const w = watcher(() => [entry]);
    await w.refresh();
    expect(w.snapshot().get("fix/thing")).toMatchObject({ dirty: false });
    expect((await stat(index)).mtimeMs).toBe(before);
  });

  it("keeps its loop going after a pass throws", async () => {
    let looks = 0;
    const w = new StatusWatcher({
      intervalMs: 5,
      pullRequests: false,
      // A different answer every time, so every pass has a change to report.
      history: async () => (looks++ % 2 === 0 ? [entry] : []),
      onChange: () => {
        throw new Error("boom");
      },
    });
    w.start();
    try {
      await vi.waitFor(() => expect(looks).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    } finally {
      w.stop();
    }
  });

  it("follows only recent sessions", async () => {
    const old = { ...entry, branch: "fix/old", createdAt: new Date(now - 30 * 24 * 3600 * 1000).toISOString() };
    const w = watcher(() => [old, entry]);
    await w.refresh();
    expect([...w.snapshot().keys()]).toEqual(["fix/thing"]);
  });
});
