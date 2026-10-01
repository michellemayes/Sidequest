import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every command the watcher ran, and what `gh pr list` answers. */
const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
let prList: Array<{ headRefName: string; number: number; state: string; url: string }> = [];

vi.mock("../src/util/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    run: vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd });
      if (command === "gh" && args[1] === "list") return { stdout: JSON.stringify(prList), stderr: "" };
      if (command === "gh") throw new actual.CommandError(command, args, 1, "", "no pull requests found");
      // git: every branch is a commit ahead and clean.
      if (args[0] === "rev-list") return { stdout: "1\n", stderr: "" };
      return { stdout: "", stderr: "" };
    }),
  };
});

const { parsePullRequestList, StatusWatcher } = await import("../src/session/status.js");
type HistoryEntry = import("../src/session/history.js").HistoryEntry;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-status-pr-"));
  calls.length = 0;
  prList = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function session(branch: string, repo: string, createdAt: number): Promise<HistoryEntry> {
  const worktreePath = join(root, branch.replace("/", "-"));
  await mkdir(worktreePath, { recursive: true });
  return {
    ts: "1.1", channel: "c", promptKey: "fix", promptLabel: "Fix", branch,
    worktreePath, repoPath: join(root, repo), repoLabel: repo,
    createdAt: new Date(createdAt).toISOString(), baseBranch: "main",
  };
}

const ghCalls = () => calls.filter((c) => c.command === "gh");

describe("parsePullRequestList", () => {
  it("maps head branches to pull requests, preferring an open one", () => {
    const list = parsePullRequestList(JSON.stringify([
      { headRefName: "fix/a", number: 3, state: "CLOSED", url: "u3" },
      { headRefName: "fix/a", number: 2, state: "OPEN", url: "u2" },
      { headRefName: "fix/b", number: 1, state: "MERGED", url: "u1" },
      { headRefName: 7, number: 0, state: "OPEN", url: "bad" },
    ]));
    expect(list?.get("fix/a")).toEqual({ number: 2, state: "OPEN", url: "u2" });
    expect(list?.get("fix/b")).toEqual({ number: 1, state: "MERGED", url: "u1" });
    expect(list?.size).toBe(2);
    expect(parsePullRequestList("nope")).toBeNull();
  });
});

describe("StatusWatcher pull requests", () => {
  it("asks gh once per repo per pass, not once per session", async () => {
    let now = Date.now();
    const history = [
      await session("fix/a", "repo", now),
      await session("fix/b", "repo", now),
      await session("fix/c", "other", now),
    ];
    prList = [{ headRefName: "fix/a", number: 9, state: "OPEN", url: "https://x/9" }];
    const w = new StatusWatcher({ history: async () => history, now: () => now });
    await w.refresh();

    expect(ghCalls().map((c) => [c.args.slice(0, 2).join(" "), c.cwd])).toEqual([
      ["pr list", join(root, "repo")],
      ["pr list", join(root, "other")],
    ]);
    expect(w.snapshot().get("fix/a")).toMatchObject({ state: "pr-open", pr: { number: 9 } });
    expect(w.snapshot().get("fix/b")).toMatchObject({ state: "committed", pr: null });

    // Within the TTL nobody is asked again.
    calls.length = 0;
    now += 30_000;
    await w.refresh();
    expect(ghCalls()).toEqual([]);
  });

  it("asks about a day-old branch with no pull request only every ten minutes", async () => {
    let now = Date.now();
    const old = await session("fix/old", "repo", now - 2 * 24 * 3600 * 1000);
    const young = await session("fix/new", "young", now);
    const w = new StatusWatcher({ history: async () => [old, young], now: () => now });
    await w.refresh();
    expect(ghCalls()).toHaveLength(2);

    calls.length = 0;
    now += 2 * 60_000;
    await w.refresh();
    // Only the young one's repo is asked again.
    expect(ghCalls().map((c) => c.cwd)).toEqual([join(root, "young")]);

    calls.length = 0;
    now += 10 * 60_000;
    await w.refresh();
    expect(ghCalls().map((c) => c.cwd).sort()).toEqual([join(root, "repo"), join(root, "young")]);
  });

  it("asks by name about a known pull request that dropped off the list", async () => {
    let now = Date.now();
    const entry = await session("fix/a", "repo", now);
    prList = [{ headRefName: "fix/a", number: 9, state: "OPEN", url: "https://x/9" }];
    const w = new StatusWatcher({ history: async () => [entry], now: () => now });
    await w.refresh();
    prList = [];
    calls.length = 0;
    now += 2 * 60_000;
    await w.refresh();
    expect(ghCalls().map((c) => c.args.slice(0, 2).join(" "))).toEqual(["pr list", "pr view"]);
    // gh view failed, so what was known stands.
    expect(w.snapshot().get("fix/a")).toMatchObject({ state: "pr-open", pr: { number: 9 } });
  });
});
