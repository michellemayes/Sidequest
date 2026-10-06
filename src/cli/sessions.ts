import { linkedRepoPaths } from "../config/channels.js";
import { loadConfig } from "../config/store.js";
import { listWorktrees } from "../git/worktree.js";
import { cleanSweepOptions, sweepWorktrees } from "../session/cleanup.js";
import { computeStats, latestSession, loadHistory, MILESTONES } from "../session/history.js";
import { findSession, openSession } from "../session/reopen.js";
import { agentDidNotStart } from "../terminals/launch.js";
import { UserFacingError } from "../util/errors.js";
import { plural } from "./shared.js";

/**
 * Open the terminal (or the agent's app) on a worktree Sidequest created
 * earlier, by branch name or path — or, with nothing named, the most recent
 * one. Handy when it opened in the
 * wrong place or the agent never started: if the session's pending marker is
 * still unclaimed, the shell hook starts the agent on arrival.
 */
export async function reopen(ref: string | undefined): Promise<void> {
  const config = await loadConfig();
  const history = await loadHistory();
  let wanted = ref?.trim() ?? "";
  if (!wanted) {
    const latest = latestSession(history);
    if (!latest) {
      throw new UserFacingError(
        "No sessions yet.",
        "Hover a message in Slack and click Sidequest to start one.",
      );
    }
    wanted = latest.branch;
  }

  const known = history.filter((h) => h.branch === wanted).map((h) => h.repoPath);
  const found = await findSession(config, wanted, known);
  if (!found) {
    throw new UserFacingError(
      `No Sidequest session found for "${wanted}".`,
      "Pass a branch name or worktree path from `sidequest sessions`.",
    );
  }
  const entry = history.filter((h) => h.worktreePath === found.worktree.path).pop();
  const launch = await openSession(config, found, entry?.agentId);
  if (launch.terminal === "headless") {
    console.log(
      launch.agentStarted === null
        ? `${found.worktree.path} has already run. ${launch.note ?? ""}`.trim()
        : `Started the agent in the background in ${found.worktree.path}; it logs to .sidequest/agent.log.`,
    );
  } else {
    console.log(`Opened ${launch.host} on ${found.worktree.path} (${launch.strategy}).`);
    if (launch.note) console.log(launch.note);
  }
  if (launch.agentStarted === false && launch.terminal) {
    console.log(
      launch.terminal === "warp"
        ? "The agent did not start. Run `sidequest install-hook`, open a new Warp tab there, or run .sidequest/autorun.sh."
        : agentDidNotStart(launch.terminal),
    );
  }
}

export async function stats(): Promise<void> {
  const history = await loadHistory();
  const s = computeStats(history);
  if (s.total === 0) {
    console.log("No sidequests yet. Hover a message in Slack and click Sidequest to start your first.");
    return;
  }

  const next = MILESTONES.find((m) => m > s.total);
  console.log(`\n  ✦ ${plural(s.total, "sidequest")}` + (next ? `  (${next - s.total} to #${next})` : ""));
  console.log(`    today:        ${s.today}`);
  console.log(`    streak:       ${plural(s.streak, "day")}${s.streak > 0 && s.today === 0 ? " — start one today to keep it" : ""}`);
  console.log(`    best streak:  ${plural(s.bestStreak, "day")}`);

  const bar = (n: number, max: number): string => "█".repeat(Math.max(1, Math.round((n / max) * 24)));
  const section = (title: string, counts: Record<string, number>, prefix = ""): void => {
    const rows = Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, 6);
    if (rows.length === 0) return;
    const max = rows[0]![1];
    const width = Math.max(...rows.map(([k]) => k.length + prefix.length));
    console.log(`\n  ${title}`);
    for (const [key, n] of rows) console.log(`    ${(prefix + key).padEnd(width)}  ${bar(n, max)} ${n}`);
  };
  section("by prompt", s.byPrompt);
  section("by channel", s.byChannel, "#");

  console.log("\n  latest");
  for (const entry of history.slice(-5).reverse()) {
    const when = new Date(entry.createdAt).toLocaleString();
    console.log(`    ${entry.branch}  ·  #${entry.channel}  ·  ${when}`);
  }
  console.log("\n`sidequest reopen` jumps back into the latest one.\n");
}

export async function sessions(): Promise<void> {
  const config = await loadConfig();
  const repos = linkedRepoPaths(config);
  if (repos.length === 0) {
    console.log("No repos are linked yet.");
    return;
  }

  for (const repoPath of repos) {
    console.log(`\n${repoPath}`);
    const worktrees = (await listWorktrees(repoPath)).filter((w) => !w.isMain);
    if (worktrees.length === 0) {
      console.log("  (no worktrees)");
      continue;
    }
    for (const w of worktrees) {
      console.log(`  ${w.branch}${w.isPrunable ? "  [stale]" : ""}`);
      console.log(`      ${w.path}`);
    }
  }
}

export async function clean(options: { force: boolean; all: boolean; recent: boolean }): Promise<void> {
  const config = await loadConfig();
  if (linkedRepoPaths(config).length === 0) {
    console.log("No repos are linked yet.");
    return;
  }

  // The rules themselves live in sweepWorktrees, shared with the daemon's
  // autoClean; this only says what happened.
  const outcomes = await sweepWorktrees(config, {
    ...cleanSweepOptions(options),
    onOutcome: (o) => {
      switch (o.kind) {
        case "removed":
          console.log(
            o.removedBranch ? `removed ${o.branch} and its worktree` : `removed worktree for ${o.branch}, kept the branch`,
          );
          break;
        case "not-merged":
          console.log(`keep    ${o.branch} — not merged into ${o.base} (use --all to remove anyway)`);
          break;
        case "dirty":
          console.log(`skip    ${o.path} — uncommitted changes (use --force)`);
          break;
        case "recent": {
          // Merged can just mean nothing committed yet: an Investigate or
          // Ask session still being read, or one still being created.
          const minutes = Math.max(1, Math.round(o.idleMs / 60_000));
          console.log(
            `keep    ${o.branch} — touched ${plural(minutes, "minute")} ago (use --recent to remove anyway)`,
          );
          break;
        }
        case "repo-error":
          console.log(`skip    ${o.repoPath} — ${o.message}`);
          break;
      }
    },
  });

  const removed = outcomes.filter((o) => o.kind === "removed").length;
  const kept = outcomes.filter((o) => o.kind === "not-merged" || o.kind === "dirty" || o.kind === "recent").length;
  console.log(
    `\nRemoved ${plural(removed, "worktree")}` +
      (kept > 0 ? `, kept ${kept}.` : "."),
  );
}
