import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolveAgent } from "../agents/agents.js";
import { launchSlack } from "../cdp/launch.js";
import { daemonLogFile, shellHookFile } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { ensureConfigRoot, loadConfig } from "../config/store.js";
import { clearDaemonRecord, daemonAlive, readDaemonRecord, readTail, rotateLog } from "../daemon.js";
import { assertGitAvailable } from "../git/repo.js";
import { finishedWorktrees } from "../session/cleanup.js";
import { computeStats, loadHistory } from "../session/history.js";
import { UserFacingError } from "../util/errors.js";
import { pidExists } from "../util/lockfile.js";
import { runAttacherLoop } from "./attachLoop.js";
import { refreshShellHook } from "./hook.js";
import { pileUpNudge, runsAs, terminalSummary } from "./shared.js";
import { sleep } from "../util/async.js";
import { exists } from "../util/fs.js";

export async function start(options: { force: boolean; foreground: boolean }): Promise<void> {
  await assertGitAvailable();
  await refreshShellHook();
  const config = await loadConfig();
  const { cdpPort, targetUrlPattern } = config.settings;

  // Check before touching Slack: `--force` would otherwise restart Slack out
  // from under a daemon that is already attached, and a second attacher
  // (daemon or --foreground) would inject the overlay twice.
  if (!process.env.SIDEQUEST_DAEMON) await assertNoRunningDaemon();

  const launch = await launchSlack({ cdpPort, force: options.force, targetUrlPattern });

  // Relaunching Slack is the disruptive part; do it up front where its errors
  // are visible, then hand the attach loop to a background daemon so no
  // terminal has to stay open.
  if (!options.foreground && !process.env.SIDEQUEST_DAEMON) {
    await startDaemonized();
    return;
  }

  await runAttacherLoop({ launch, config });
}

async function assertNoRunningDaemon(): Promise<void> {
  const existing = await readDaemonRecord();
  if (existing && (await daemonAlive(existing))) {
    throw new UserFacingError(
      `Sidequest is already running in the background (pid ${existing.pid}).`,
      "Run `sidequest stop` first, or `sidequest status` to check on it.",
    );
  }
  if (existing) await clearDaemonRecord();
}

/**
 * Spawn a detached child that runs the attach loop, then exit. The child
 * writes its pid file on boot; the parent waits for it briefly so a fast
 * failure (bad config, port taken) surfaces instead of a false "running".
 */
async function startDaemonized(): Promise<void> {
  await ensureConfigRoot();
  const logFile = daemonLogFile();
  // Rotated here rather than by the daemon: its output goes straight to the
  // file through the descriptor opened below, which a rename would orphan.
  await rotateLog(logFile);
  const out = openSync(logFile, "a");
  // execArgv carries loaders such as tsx (`npm run dev`) over to the child.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SIDEQUEST_DAEMON: "1" },
  });
  // The child has its own copy of the descriptor now.
  closeSync(out);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const deadline = Date.now() + 8000;
  // A child that died at boot is not going to write its record; stop waiting.
  while (!exited) {
    const rec = await readDaemonRecord();
    if (rec && (await daemonAlive(rec))) {
      const config = await loadConfig();
      const agent = resolveAgent(config.settings.agent);
      console.log(`Sidequest is running in the background (pid ${rec.pid}).`);
      console.log(`  agent: ${agent.label} — hover a message in Slack and click Sidequest.`);
      console.log(`  log:   ${logFile}`);
      console.log("  `sidequest stop` stops it; `sidequest status` checks on it.");
      for (const tip of await startTips(config)) console.log(`\ntip: ${tip}`);
      return;
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  throw new UserFacingError(
    "Sidequest did not stay up.",
    `Something failed during startup — see ${logFile}.`,
  );
}

/** What would make the first minutes smoother, said once at start. */
async function startTips(config: Config): Promise<string[]> {
  const tips: string[] = [];
  if (Object.keys(config.channels).length === 0) {
    tips.push(
      "no channel has a repo yet. Hover any message, click Sidequest, and pick one of the " +
        "repos it suggests — it looks for checkouts that match the channel's name.",
    );
  }
  const usesWarp = config.settings.terminal === "warp" && !resolveAgent(config.settings.agent).app;
  if (usesWarp && !(await exists(shellHookFile()))) {
    tips.push("run `sidequest install-hook` so the agent starts even when Warp ignores the launch config.");
  }
  const pile = await pileUpNudge(config);
  if (pile) tips.push(pile);
  return tips;
}

/**
 * How long `stop` waits before a SIGKILL. Longer than DAEMON_DRAIN_MS, the
 * time the daemon gives a session that is starting to finish.
 */
const STOP_GRACE_MS = 8000;

export async function stop(): Promise<void> {
  const rec = await readDaemonRecord();
  if (!rec) {
    console.log("Sidequest is not running.");
    return;
  }
  if (!(await daemonAlive(rec))) {
    await clearDaemonRecord();
    console.log("Sidequest was not running (cleaned up a stale pid file).");
    return;
  }
  signal(rec.pid, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (pidExists(rec.pid) && Date.now() < deadline) await sleep(250);
  // Checked again before the SIGKILL: in those seconds the pid could have
  // been freed and reused.
  if (await daemonAlive(rec)) signal(rec.pid, "SIGKILL");
  await clearDaemonRecord();
  console.log("Stopped Sidequest.");
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already, or not ours to signal.
  }
}

export async function status(): Promise<void> {
  const config = await loadConfig();
  const agent = resolveAgent(config.settings.agent);
  const rec = await readDaemonRecord();
  if (rec === null || !(await daemonAlive(rec))) {
    if (rec) await clearDaemonRecord();
    console.log("Sidequest is not running.");
  } else {
    const started = rec.startedAt ? `, started ${rec.startedAt}` : "";
    console.log(`Sidequest is running (pid ${rec.pid}${started}).`);
    const attached = await lastAttachedCount(daemonLogFile());
    if (attached !== null) console.log(`Slack windows with the overlay: ${attached}`);
    console.log(`Log: ${daemonLogFile()}`);
  }
  console.log(`Agent: ${agent.label} (${runsAs(config, agent)})`);
  console.log(`Terminal: ${terminalSummary(config.settings.terminal, agent)}`);
  console.log(`Linked channels: ${Object.keys(config.channels).length}`);
  const s = computeStats(await loadHistory());
  if (s.total > 0) {
    console.log(
      `Sidequests: ${s.total} (${s.today} today` +
        (s.streak > 1 ? `, ${s.streak}-day streak` : "") +
        ") — `sidequest stats` for more",
    );
  }
  const { autoClean, autoCleanAfterDays } = config.settings;
  if (autoClean) {
    console.log(`Auto-clean: on (merged worktrees idle over ${autoCleanAfterDays} days)`);
  } else {
    const finished = (await finishedWorktrees(config).catch(() => [])).length;
    if (finished > 0) {
      console.log(
        `Finished worktrees: ${finished} (merged, untouched for ${autoCleanAfterDays}+ days) — ` +
          "`sidequest clean` removes them, or turn on settings.autoClean",
      );
    }
  }
}

/**
 * Best-effort read of the attach count from the daemon's log. Only the tail
 * is read: the log can run to megabytes, and the latest count is near its
 * end. A count logged so long ago that it has scrolled out of the tail is
 * left unsaid rather than read the whole file for.
 */
async function lastAttachedCount(logFile: string): Promise<number | null> {
  const lines = (await readTail(logFile, 256 * 1024)).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = (lines[i] ?? "").match(/attached to a Slack window \((\d+) total\)/);
    if (m) return Number.parseInt(m[1]!, 10);
  }
  return null;
}
