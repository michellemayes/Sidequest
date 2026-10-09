/**
 * The session list the Mac app's tests decode, from a fixed history. The
 * control tests check the fixture still matches what the daemon sends, so
 * the two sides cannot drift apart without a test saying so.
 */
import { appSessions } from "../../src/control/app.js";
import type { HistoryEntry } from "../../src/session/history.js";
import type { SessionStatus } from "../../src/session/status.js";

export const FIXTURE_PATH = new URL("../../mac/Tests/SidequestTests/Fixtures/sessions.json", import.meta.url);

export function fixtureSessions(): { sessions: ReturnType<typeof appSessions>; stats: Record<string, number> } {
  const base: HistoryEntry = {
    ts: "1760000000.000100",
    channel: "storefront-eng",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: "claude/fix-checkout-total",
    worktreePath: "/Users/dana/.sidequest/worktrees/storefront/claude-fix-checkout-total",
    repoPath: "/Users/dana/code/storefront",
    repoLabel: "storefront",
    createdAt: "2026-10-09T14:31:00.000Z",
    permalink: "https://acme.slack.com/archives/C01/p1760000000000100",
    baseBranch: "main",
    agentLabel: "Claude Code",
    agentId: "claude",
    message: "Checkout total is off by a cent on some carts with discounts",
    author: "dana",
  };
  const history: HistoryEntry[] = [
    { ...base, branch: "investigate/webhook-502s", promptKey: "investigate", promptLabel: "Investigate",
      worktreePath: "/Users/dana/.sidequest/worktrees/payments/investigate-webhook-502s", repoLabel: "payments",
      repoPath: "/Users/dana/src/payments", channel: "payments", message: "Webhook 502s since deploy", author: "sam",
      createdAt: "2026-10-09T13:58:00.000Z" },
    base,
  ];
  const statuses = new Map<string, SessionStatus>([
    ["claude/fix-checkout-total", { state: "pr-open", commits: 2, dirty: false, pr: { number: 128, url: "https://github.com/acme/storefront/pull/128", state: "OPEN" }, resultMs: 1760020000000, resultPending: true, exitCode: null }],
    ["investigate/webhook-502s", { state: "failed", commits: 0, dirty: false, pr: null, resultMs: null, resultPending: false, exitCode: 1 }],
  ]);
  return {
    sessions: appSessions(history, statuses, { postResults: "ask" }),
    stats: { total: 2, today: 2, streak: 6, bestStreak: 9, firstToday: 0 },
  };
}
