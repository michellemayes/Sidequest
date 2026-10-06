import { describe, expect, it } from "vitest";
import { noticeArgs, noticesFor } from "../src/session/notices.js";
import type { SessionStatus } from "../src/session/status.js";
import type { HistoryEntry } from "../src/session/history.js";

const status = (patch: Partial<SessionStatus> = {}): SessionStatus => ({
  state: "working",
  commits: 0,
  dirty: false,
  pr: null,
  resultMs: null,
  resultPending: false,
  exitCode: null,
  ...patch,
});

const entry = (branch: string, createdAt = "2026-10-01T00:00:00Z"): HistoryEntry => ({
  ts: "1.2",
  channel: "eng",
  promptKey: "fix",
  promptLabel: "Fix",
  branch,
  worktreePath: `/w/${branch}`,
  repoPath: "/r",
  repoLabel: "storefront",
  createdAt,
});

const PR = { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN" as const };
const since = Date.parse("2026-10-05T00:00:00Z");

describe("desktop notices", () => {
  it("announces a reply, a pull request opening and merging, and a failed run", () => {
    const history = ["a", "b", "c", "d"].map((b) => entry(b));
    const before = new Map([
      ["a", status()],
      ["b", status({ state: "committed", commits: 1 })],
      ["c", status({ state: "pr-open", pr: PR })],
      ["d", status()],
    ]);
    const after = new Map([
      ["a", status({ state: "answered", resultMs: 1, resultPending: true })],
      ["b", status({ state: "pr-open", commits: 1, pr: PR })],
      ["c", status({ state: "merged", pr: { ...PR, state: "MERGED" } })],
      ["d", status({ state: "failed", exitCode: 3 })],
    ]);
    const titles = noticesFor(before, after, history, { postResults: "ask", since }).map((n) => n.title);
    expect(titles).toEqual([
      "Fix has a reply for the thread",
      "Fix opened PR #42",
      "Fix merged",
      "Fix failed",
    ]);
  });

  it("says nothing about what was already so when the daemon started", () => {
    const after = new Map([["old", status({ state: "merged", resultPending: true })]]);
    expect(noticesFor(new Map(), after, [entry("old")], { postResults: "ask", since })).toEqual([]);
  });

  it("counts a session started since as having been working before its first look", () => {
    const after = new Map([["new", status({ state: "failed", exitCode: 1 })]]);
    const notices = noticesFor(new Map(), after, [entry("new", "2026-10-06T00:00:00Z")], { postResults: "ask", since });
    expect(notices).toEqual([{ title: "Fix failed", body: "The agent exited with 1. storefront · new" }]);
  });

  it("does not call you back for a reply that posts itself", () => {
    const before = new Map([["a", status()]]);
    const after = new Map([["a", status({ resultMs: 1, resultPending: true })]]);
    expect(noticesFor(before, after, [entry("a")], { postResults: "auto", since })).toEqual([]);
  });

  it("hands the text to AppleScript as arguments, never as its source", () => {
    const args = noticeArgs({ title: 'x" & do shell script "rm -rf ~', body: "b" });
    expect(args.filter((a, i) => args[i - 1] === "-e").join("\n")).not.toContain("rm -rf");
    expect(args.slice(-2)).toEqual(['x" & do shell script "rm -rf ~', "b"]);
  });
});
