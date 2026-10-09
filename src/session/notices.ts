/**
 * Desktop notifications for the moments a session needs you.
 *
 * The toast in Slack only reaches you while you are looking at Slack, and a
 * session that runs for twenty minutes is exactly when you are not: you are
 * in the terminal, the editor, another meeting. So when a session moves on
 * in a way worth stopping for — a reply waiting to be read, a pull request
 * opened or merged, a headless run that failed — the daemon also says so in
 * a macOS notification. Only the move is news: a session already in that
 * state when the daemon started is not announced again.
 */
import type { PostResults } from "../config/schema.js";
import { run } from "../util/exec.js";
import { platform } from "../util/platform.js";
import { log } from "../util/log.js";
import type { HistoryEntry } from "./history.js";
import type { SessionStatus } from "./status.js";

export interface Notice {
  title: string;
  body: string;
  /** The session it is about, so the Mac app can open it from the notification. */
  branch?: string;
}

/** What a session started since the daemon began counts as having been before its first look. */
const FRESH: Pick<SessionStatus, "state" | "resultPending"> = { state: "working", resultPending: false };

/**
 * What changed between two looks at the sessions that is worth a
 * notification. `since` is when the daemon started following them: a
 * session it has not seen before is news only if it started after that.
 */
export function noticesFor(
  before: Map<string, SessionStatus>,
  after: Map<string, SessionStatus>,
  history: HistoryEntry[],
  options: { postResults: PostResults; since: number },
): Notice[] {
  const notices: Notice[] = [];
  const entries = new Map(history.map((entry) => [entry.branch, entry]));
  for (const [branch, next] of after) {
    const entry = entries.get(branch);
    const fresh = entry && Date.parse(entry.createdAt) >= options.since ? FRESH : undefined;
    const prev = before.get(branch) ?? fresh;
    if (!prev) continue;
    const label = entry?.promptLabel || "A session";
    const where = entry?.repoLabel ? `${entry.repoLabel} · ${branch}` : branch;

    if (next.state !== prev.state) {
      if (next.state === "pr-open" && next.pr) {
        notices.push({ title: `${label} opened PR #${next.pr.number}`, body: where, branch });
      } else if (next.state === "merged") {
        notices.push({ title: `${label} merged`, body: next.pr ? `PR #${next.pr.number} · ${where}` : where, branch });
      } else if (next.state === "failed") {
        notices.push({
          title: `${label} failed`,
          body: `The agent exited with ${next.exitCode ?? "an error"}. ${where}`,
          branch,
        });
      }
    }
    // On auto the reply is posted without you; nothing to come back for.
    if (next.resultPending && !prev.resultPending && options.postResults === "ask") {
      notices.push({ title: `${label} has a reply for the thread`, body: `Review it in Slack. ${where}`, branch });
    }
  }
  return notices;
}

/**
 * Show one notification, on macOS. The text goes in as arguments to the
 * AppleScript, never into its source, so a branch name cannot be read as
 * script. Elsewhere, and on failure, it is logged and dropped: a missed
 * notification is never worth an error.
 */
export async function showNotice(notice: Notice): Promise<void> {
  if (platform() !== "darwin") {
    log.debug(`notice (not on macOS): ${notice.title}: ${notice.body}`);
    return;
  }
  try {
    await run("/usr/bin/osascript", noticeArgs(notice), { timeoutMs: 10_000 });
  } catch (err) {
    log.debug(`could not show a notification: ${String(err)}`);
  }
}

export function noticeArgs(notice: Notice): string[] {
  return [
    "-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title \"Sidequest\" subtitle (item 1 of argv)",
    "-e", "end run",
    notice.title,
    notice.body,
  ];
}
