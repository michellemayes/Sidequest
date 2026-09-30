import { Command } from "commander";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { configFile, configRoot, daemonLogFile, shellHookFile } from "./config/paths.js";
import {
  allPrompts,
  ensureConfigRoot,
  expandPath,
  loadConfig,
  saveConfig,
  updateConfig,
} from "./config/store.js";
import { assertGitAvailable, inspectRepo, isMergedInto } from "./git/repo.js";
import { listWorktrees, pruneWorktrees, removeWorktree } from "./git/worktree.js";
import { shellHookSource } from "./warp/autorun.js";
import { findSession, openSession } from "./session/reopen.js";
import { computeStats, latestSession, loadHistory, MILESTONES } from "./session/history.js";
import { AGENT_DEFINITIONS, agentDefinition, resolveAgent } from "./agents/agents.js";
import {
  clearDaemonRecord,
  daemonAlive,
  readDaemonRecord,
  writeDaemonRecord,
} from "./daemon.js";
import { warpLaunchConfigDir, warpTabConfigDir, platform, uriOpener } from "./util/platform.js";
import { Attacher } from "./cdp/attacher.js";
import { SlackKeeper } from "./cdp/keeper.js";
import { findSlackApp, inspectDebugPort, isSlackRunning, launchSlack, sleep } from "./cdp/launch.js";
import { channelKey } from "./config/channels.js";
import { describeError, UserFacingError } from "./util/errors.js";
import type { Config } from "./config/schema.js";
import type { LaunchResult } from "./cdp/launch.js";
import { succeeds } from "./util/exec.js";
import { log } from "./util/log.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("sidequest")
    .description("Turn any Slack message into an agent session in a fresh git worktree, opened in Warp.")
    .version("0.1.0");

  program
    .command("setup")
    .description("everything in one go: config, shell hook, checks, then start")
    .option("--force", "quit a running Slack that has no DevTools port", false)
    .action((options: { force: boolean }) => wrap(() => setup(options)));

  program
    .command("start")
    .description("launch Slack with the overlay attached (runs in the background by default)")
    .option("--force", "quit a running Slack that has no DevTools port", false)
    .option("--foreground", "stay in the foreground instead of daemonizing", false)
    .action((options: { force: boolean; foreground: boolean }) => wrap(() => start(options)));

  program
    .command("stop")
    .description("stop the background Sidequest daemon")
    .action(() => wrap(stop));

  program
    .command("status")
    .description("show whether the background daemon is running")
    .action(() => wrap(status));

  program
    .command("agents")
    .description("list the coding agents Sidequest can launch")
    .action(() => wrap(agents));

  program
    .command("reopen [ref]")
    .description("open Warp on a session again (branch name or path; default: the latest)")
    .action((ref: string | undefined) => wrap(() => reopen(ref)));

  program
    .command("stats")
    .description("how many sidequests, how many today, and your streak")
    .action(() => wrap(stats));

  program
    .command("link <path>")
    .description("link a Slack channel to a repo from the terminal")
    .requiredOption("-c, --channel <name>", "channel name, e.g. eng-alerts")
    .option("-b, --base <branch>", "branch to cut worktrees from (default: detected)")
    .option("-l, --label <name>", "display name for the repo")
    .action((path: string, options: { channel: string; base?: string; label?: string }) =>
      wrap(() => link(path, options)),
    );

  program
    .command("unlink")
    .description("remove a channel's repo link")
    .requiredOption("-c, --channel <name>", "channel name, e.g. eng-alerts")
    .action((options: { channel: string }) => wrap(() => unlink(options.channel)));

  program
    .command("list")
    .description("show linked channels and settings")
    .action(() => wrap(list));

  program
    .command("sessions")
    .description("list worktrees Sidequest has created")
    .action(() => wrap(sessions));

  program
    .command("clean")
    .description("remove finished worktrees")
    .option("--force", "also remove worktrees with uncommitted changes", false)
    .option("--all", "remove every Sidequest worktree, not just merged ones", false)
    .action((options: { force: boolean; all: boolean }) => wrap(() => clean(options)));

  program
    .command("init")
    .description("write a starter config to ~/.sidequest")
    .action(() => wrap(() => init()));

  program
    .command("install-hook")
    .description("add the shell hook that starts Claude when a worktree tab opens")
    .option("--rc <path>", "shell rc file to modify (default: detected)")
    .option("--print", "print the snippet instead of writing it", false)
    .action((options: { rc?: string; print: boolean }) => wrap(() => installHook(options)));

  program
    .command("prompts")
    .description("show the three prompt templates and where to override them")
    .action(() => wrap(prompts));

  program
    .command("doctor")
    .description("check that git, Warp, the agent and Slack are all usable")
    .action(() => wrap(doctor));

  await program.parseAsync(argv);
}

/** Turn thrown errors into a clean message plus a non-zero exit. */
async function wrap(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const { message, hint } = describeError(err);
    console.error(`\nerror: ${message}`);
    if (hint) console.error(`hint:  ${hint}`);
    if (!(err instanceof UserFacingError)) log.debug("stack", err);
    process.exitCode = 1;
  }
}

async function start(options: { force: boolean; foreground: boolean }): Promise<void> {
  await assertGitAvailable();
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
  if (existing && daemonAlive(existing.pid)) {
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
  const out = openSync(logFile, "a");
  // execArgv carries loaders such as tsx (`npm run dev`) over to the child.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SIDEQUEST_DAEMON: "1" },
  });
  child.unref();

  const deadline = Date.now() + 8000;
  for (;;) {
    const rec = await readDaemonRecord();
    if (rec && daemonAlive(rec.pid)) {
      const agent = resolveAgent((await loadConfig()).settings.agent);
      const config = await loadConfig();
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
  if (!(await fileExists(shellHookFile()))) {
    tips.push("run `sidequest install-hook` so the agent starts even when Warp ignores the launch config.");
  }
  return tips;
}

async function stop(): Promise<void> {
  const rec = await readDaemonRecord();
  if (!rec) {
    console.log("Sidequest is not running.");
    return;
  }
  if (!daemonAlive(rec.pid)) {
    await clearDaemonRecord();
    console.log("Sidequest was not running (cleaned up a stale pid file).");
    return;
  }
  process.kill(rec.pid, "SIGTERM");
  const deadline = Date.now() + 8000;
  while (daemonAlive(rec.pid) && Date.now() < deadline) await sleep(250);
  if (daemonAlive(rec.pid)) process.kill(rec.pid, "SIGKILL");
  await clearDaemonRecord();
  console.log("Stopped Sidequest.");
}

async function status(): Promise<void> {
  const config = await loadConfig();
  const agent = resolveAgent(config.settings.agent);
  const rec = await readDaemonRecord();
  if (rec === null || !daemonAlive(rec.pid)) {
    if (rec) await clearDaemonRecord();
    console.log("Sidequest is not running.");
  } else {
    const started = rec.startedAt ? `, started ${rec.startedAt}` : "";
    console.log(`Sidequest is running (pid ${rec.pid}${started}).`);
    const attached = await lastAttachedCount(daemonLogFile());
    if (attached !== null) console.log(`Slack windows with the overlay: ${attached}`);
    console.log(`Log: ${daemonLogFile()}`);
  }
  console.log(`Agent: ${agent.label} (${[agent.command, ...agent.args].join(" ")})`);
  console.log(`Linked channels: ${Object.keys(config.channels).length}`);
  const s = computeStats(await loadHistory());
  if (s.total > 0) {
    console.log(
      `Sidequests: ${s.total} (${s.today} today` +
        (s.streak > 1 ? `, ${s.streak}-day streak` : "") +
        ") — `sidequest stats` for more",
    );
  }
}

/** Best-effort read of the attach count from the daemon's log tail. */
async function lastAttachedCount(logFile: string): Promise<number | null> {
  try {
    const text = await readFile(logFile, "utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? "";
      const m = line.match(/attached to a Slack window \((\d+) total\)/);
      if (m) return Number.parseInt(m[1]!, 10);
    }
    return null;
  } catch {
    return null;
  }
}

async function agents(): Promise<void> {
  const config = await loadConfig();
  const activeId = resolveAgent(config.settings.agent).id;
  console.log("Agents Sidequest can launch:\n");
  for (const def of AGENT_DEFINITIONS) {
    const marker = def.id === activeId ? "  (active)" : "";
    console.log(`  ${def.id}${marker}`);
    console.log(`    ${def.label} — ${[def.command, ...def.defaultArgs].join(" ")}`);
  }
  console.log(`\nSwitch in ${configFile()}:`);
  console.log(`  { "settings": { "agent": { "id": "codex" } } }`);
  console.log("`command` and `args` override the agent's executable and flags.");
}

/**
 * Open Warp on a worktree Sidequest created earlier, by branch name or path —
 * or, with nothing named, the most recent one. Handy when Warp opened in the
 * wrong place or the agent never started: if the session's pending marker is
 * still unclaimed, the shell hook starts the agent on arrival.
 */
async function reopen(ref: string | undefined): Promise<void> {
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
  const launch = await openSession(config, found);
  console.log(`Opened Warp on ${found.worktree.path} (${launch.strategy}).`);
  if (launch.agentStarted === false) {
    console.log("The agent did not start. Run `sidequest install-hook`, open a new Warp tab there, or run .sidequest/autorun.sh.");
  }
}

async function stats(): Promise<void> {
  const history = await loadHistory();
  const s = computeStats(history);
  if (s.total === 0) {
    console.log("No sidequests yet. Hover a message in Slack and click Sidequest to start your first.");
    return;
  }

  const next = MILESTONES.find((m) => m > s.total);
  console.log(`\n  ✦ ${s.total} sidequest${s.total === 1 ? "" : "s"}` + (next ? `  (${next - s.total} to #${next})` : ""));
  console.log(`    today:        ${s.today}`);
  console.log(`    streak:       ${s.streak} day${s.streak === 1 ? "" : "s"}${s.streak > 0 && s.today === 0 ? " — start one today to keep it" : ""}`);
  console.log(`    best streak:  ${s.bestStreak} day${s.bestStreak === 1 ? "" : "s"}`);

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

/**
 * First run, start to finish: a config to edit, the shell hook, a doctor
 * pass, and — if nothing is broken — Slack with the overlay on it. Each step
 * is the command of the same name, so running it twice changes nothing.
 */
async function setup(options: { force: boolean }): Promise<void> {
  console.log("1/4  config");
  await init({ quiet: true });
  console.log("2/4  shell hook");
  if (await fileExists(shellHookFile())) console.log(`     already installed at ${shellHookFile()}`);
  else await installHook({ print: false });
  console.log("3/4  checks");
  await doctor();
  if (process.exitCode) {
    console.log("Fix what doctor flagged above, then run `sidequest setup` again.");
    return;
  }
  console.log("4/4  start");
  await start({ force: options.force, foreground: false });
}

async function runAttacherLoop(options: {
  launch: LaunchResult;
  config: Config;
}): Promise<void> {
  const { launch, config } = options;
  const { cdpPort, targetUrlPattern } = config.settings;
  const daemonized = Boolean(process.env.SIDEQUEST_DAEMON);
  const agentLabel = resolveAgent(config.settings.agent).label;

  if (daemonized) await writeDaemonRecord();
  // Until the banner is out, `start` reports the attach state itself; a running
  // commentary before it would say the same thing twice, out of order.
  let booted = false;
  const attacher = new Attacher({
    cdpPort,
    targetUrlPattern,
    onEvent: (event) => {
      switch (event.type) {
        case "attached":
          console.log(`attached to a Slack window (${attacher.attachedCount} total)`);
          break;
        case "no-targets":
          // Only raised when the state changes, so this is not a per-poll line.
          if (booted) console.log(`waiting for a Slack window — ${event.message}`);
          break;
        case "detached":
          if (booted) {
            console.log(
              attacher.attachedCount === 0
                ? "the last Slack window went away — waiting for one to come back"
                : `a Slack window went away (${attacher.attachedCount} left)`,
            );
          }
          break;
        case "session":
          console.log(`${event.prompt} in #${event.channel} → ${event.branch}`);
          break;
        case "session-error":
          console.error(`could not start a session in #${event.channel}: ${event.message}`);
          break;
        case "link":
          console.log(`linked #${event.channel} → ${event.message}`);
          break;
        case "unlink":
          console.log(`unlinked #${event.channel}`);
          break;
        case "attach-error":
        case "poll-error":
        case "ask-error":
          log.warn(`${event.type}: ${event.message}`);
          break;
        default:
          log.debug(event.type, event);
      }
    },
  });

  await attacher.start();

  const keeper = new SlackKeeper({
    cdpPort,
    targetUrlPattern,
    onEvent: (event) => {
      switch (event.type) {
        case "relaunching":
          console.log("Slack was opened without its DevTools port — relaunching it with the port open");
          break;
        case "relaunched":
          console.log("Slack relaunched; reattaching");
          void attacher.sweepNow();
          break;
        case "relaunch-error":
          log.warn(`could not relaunch Slack: ${event.message}`);
          break;
      }
    },
  });
  if (config.settings.relaunchSlack) keeper.start();

  const linked = Object.keys(config.channels).length;
  console.log(
    launch.started
      ? "Started Slack with its DevTools port open."
      : "Slack was already listening on its DevTools port.",
  );
  console.log(`  config:    ${configFile()}`);
  console.log(`  worktrees: ${config.settings.worktreesRoot}`);
  console.log(`  channels:  ${linked} linked`);
  console.log(`  windows:   ${attacher.attachedCount} attached`);

  if (attacher.attachedCount === 0) {
    const { targets } = attacher.lastSweep;
    console.log(
      `\nNo Slack window is attached yet. The DevTools endpoint on ${cdpPort} reports ` +
        `${targets} target${targets === 1 ? "" : "s"}, none matching /${targetUrlPattern}/.\n` +
        "Sidequest keeps looking every few seconds, so opening or reloading Slack is enough.\n" +
        "If it never attaches, Slack is probably not the app on that port — see `sidequest doctor`.",
    );
  }

  console.log(
    `\nHover a message in Slack and click Sidequest to start a ${agentLabel} session.\n` +
      (daemonized ? "Running in the background; `sidequest stop` stops it.\n" : "Ctrl-C to stop.\n") +
      (config.settings.relaunchSlack
        ? "If you quit and reopen Slack, Sidequest relaunches it with the port open.\n"
        : "") +
      "Stopping leaves Slack running; the overlay disappears on its next reload.",
  );
  booted = true;

  const shutdown = (): void => {
    console.log("\nstopping…");
    keeper.stop();
    attacher.stop();
    if (daemonized) void clearDaemonRecord().finally(() => process.exit(0));
    else process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function link(
  path: string,
  options: { channel: string; base?: string; label?: string },
): Promise<void> {
  const repo = await inspectRepo(expandPath(path));
  const key = channelKey(options.channel);
  await updateConfig((config) => {
    config.channels[key] = {
      repoPath: repo.root,
      channel: key,
      baseBranch: options.base ?? "",
      label: options.label ?? "",
      linkedBy: "cli",
      linkedAt: new Date().toISOString(),
    };
  });
  console.log(`Linked #${key} → ${repo.root}`);
  console.log(`Base branch: ${options.base || repo.defaultBranch}${options.base ? "" : " (detected)"}`);
}

async function unlink(channel: string): Promise<void> {
  const key = channelKey(channel);
  const existed = await updateConfig((config) => {
    const had = Boolean(config.channels[key]);
    delete config.channels[key];
    return had;
  });
  console.log(existed ? `Unlinked #${key}.` : `#${key} was not linked.`);
}

async function list(): Promise<void> {
  const config = await loadConfig();
  const entries = Object.entries(config.channels);
  const agent = resolveAgent(config.settings.agent);

  console.log(`config: ${configFile()}\n`);
  console.log("settings");
  console.log(`  worktreesRoot:  ${config.settings.worktreesRoot}`);
  console.log(`  warpStrategy:   ${config.settings.warpStrategy}${config.settings.warpPreview ? " (preview)" : ""}`);
  console.log(`  agent:          ${agent.label} (${[agent.command, ...agent.args].join(" ")})`);
  console.log(`  threadContext:  ${config.settings.threadContextLimit} messages`);

  console.log("\nlinked channels");
  if (entries.length === 0) {
    console.log("  (none yet — hover a message in Slack, click Sidequest, and pick a repo)");
    return;
  }
  for (const [id, l] of entries) {
    console.log(`  #${id} → ${l.repoPath}`);
    console.log(`      base: ${l.baseBranch || "(detected)"}   label: ${l.label || basename(l.repoPath)}`);
  }
}

async function sessions(): Promise<void> {
  const config = await loadConfig();
  const repos = uniqueRepoPaths(config.channels);
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

async function clean(options: { force: boolean; all: boolean }): Promise<void> {
  const config = await loadConfig();
  const repos = uniqueRepoPaths(config.channels);
  if (repos.length === 0) {
    console.log("No repos are linked yet.");
    return;
  }

  let removed = 0;
  let kept = 0;

  for (const repoPath of repos) {
    await pruneWorktrees(repoPath);
    const repo = await inspectRepo(repoPath);
    const base = baseBranchFor(config.channels, repoPath) || repo.defaultBranch;

    // Only ever touch worktrees sidequest created, never a worktree the user made
    // by hand elsewhere in the same repo.
    const worktrees = (await listWorktrees(repoPath)).filter(
      (w) => !w.isMain && w.path.startsWith(config.settings.worktreesRoot),
    );

    for (const w of worktrees) {
      if (!options.all && !(await isMergedInto(repoPath, w.branch, base))) {
        console.log(`keep    ${w.branch} — not merged into ${base} (use --all to remove anyway)`);
        kept += 1;
        continue;
      }

      const result = await removeWorktree(repoPath, w.path, {
        force: options.force,
        deleteBranch: config.settings.pruneBranchesOnClean ? w.branch : undefined,
      });

      if (!result.removedWorktree) {
        console.log(`skip    ${w.path} — uncommitted changes (use --force)`);
        kept += 1;
        continue;
      }

      removed += 1;
      console.log(
        result.removedBranch
          ? `removed ${w.branch} and its worktree`
          : `removed worktree for ${w.branch}, kept the branch`,
      );
    }
  }

  console.log(
    `\nRemoved ${removed} worktree${removed === 1 ? "" : "s"}` +
      (kept > 0 ? `, kept ${kept}.` : "."),
  );
}

/** The base branch configured for whichever channel links this repo. */
function baseBranchFor(
  channels: Record<string, { repoPath: string; baseBranch: string }>,
  repoPath: string,
): string {
  for (const link of Object.values(channels)) {
    if (link.repoPath === repoPath && link.baseBranch.trim()) return link.baseBranch.trim();
  }
  return "";
}

async function init(options: { quiet?: boolean } = {}): Promise<void> {
  const root = await ensureConfigRoot();
  // Round-trips defaults into the file so it is there to edit.
  await saveConfig(await loadConfig());

  console.log(`${options.quiet ? "     " : ""}Wrote ${configFile()}`);
  if (options.quiet) return;
  console.log(`Config lives in ${root}.`);
  console.log("\nNext:");
  console.log("  1. sidequest install-hook   (so sessions start when the Warp tab opens)");
  console.log("  2. sidequest start          (launches Slack with the overlay attached)");
  console.log("  3. In Slack, click 'Link a repo' in a channel header.");
}

async function installHook(options: { rc?: string; print: boolean }): Promise<void> {
  const snippet = shellHookSource();
  const hookPath = shellHookFile();

  if (options.print) {
    console.log(snippet);
    return;
  }

  await mkdir(configRoot(), { recursive: true });
  await writeFile(hookPath, snippet, "utf8");

  const rc = options.rc ? expandPath(options.rc) : detectRcFile();
  const sourceLine = `[ -f "${hookPath}" ] && . "${hookPath}"`;
  const existing = await readFileOrEmpty(rc);

  if (existing.includes(hookPath)) {
    console.log(`${rc} already sources the hook — nothing to do.`);
    return;
  }

  await appendFile(rc, `\n# sidequest\n${sourceLine}\n`, "utf8");
  console.log(`Wrote ${hookPath}`);
  console.log(`Added a source line to ${rc}`);
  console.log("\nOpen a new terminal for it to take effect.");
}

/** Pick the rc file for the user's login shell. */
function detectRcFile(): string {
  const shell = basename(process.env.SHELL ?? "zsh");
  switch (shell) {
    case "bash":
      return join(homedir(), ".bashrc");
    case "fish":
      // The fish snippet is POSIX-ish enough to fail loudly rather than silently.
      throw new UserFacingError(
        "fish is not supported by the generated hook.",
        `Run \`sidequest install-hook --print\` and translate it, or set warpStrategy to "launch_config".`,
      );
    default:
      return join(homedir(), ".zshrc");
  }
}

async function prompts(): Promise<void> {
  const config = await loadConfig();
  for (const { key, prompt } of allPrompts(config)) {
    const overridden = config.prompts[key] !== undefined;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`${prompt.label}  (key: ${key}, branch prefix: ${prompt.branchPrefix}/)`);
    console.log(overridden ? "customised in config.json" : "built-in default");
    console.log("=".repeat(70));
    console.log(prompt.template);
  }
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Override any of these under "prompts" in ${configFile()}.`);
  console.log(`Tokens: ${PROMPT_TOKENS.map((t) => `{{${t}}}`).join(", ")}`);
}

/** Tokens a custom prompt template may use; see src/config/prompts.ts. */
const PROMPT_TOKENS = [
  "author",
  "channel",
  "message",
  "thread",
  "permalink",
  "date",
  "branch",
  "baseBranch",
  "repo",
  "worktree",
] as const;

async function doctor(): Promise<void> {
  const config = await loadConfig();
  let problems = 0;

  const check = (ok: boolean, label: string, detail: string): void => {
    console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
    if (detail) console.log(`       ${detail}`);
    if (!ok) problems += 1;
  };

  console.log("\nsidequest doctor\n");

  check(await succeeds("git", ["--version"]), "git", "required to create worktrees");

  const agent = resolveAgent(config.settings.agent);
  const agentOk = await succeeds(agent.command, ["--version"]);
  check(
    agentOk,
    `${agent.label} (${agent.command})`,
    agentOk ? "" : agentDefinition(agent.id).installHint,
  );

  const opener = uriOpener();
  check(
    opener !== null,
    `URI opener for ${platform()}`,
    opener ? `${opener.command}` : "no known way to open warp:// links on this platform",
  );

  const warpDir =
    config.settings.warpStrategy === "tab_config"
      ? warpTabConfigDir(config.settings.warpPreview)
      : warpLaunchConfigDir(config.settings.warpPreview);
  console.log(`  ok   warp strategy: ${config.settings.warpStrategy}`);
  console.log(`       writes to ${warpDir}`);

  const hookInstalled = await fileExists(shellHookFile());
  console.log(`  ${hookInstalled ? "ok " : "-- "}  shell hook`);
  console.log(
    hookInstalled
      ? `       installed at ${shellHookFile()}`
      : `       not installed. Run \`sidequest install-hook\` so sessions start even when Warp ignores the launch config.`,
  );

  const app = findSlackApp();
  check(
    app !== null,
    "Slack desktop app",
    app ?? "not found in /Applications or ~/Applications",
  );

  const port = await inspectDebugPort(config.settings.cdpPort, config.settings.targetUrlPattern);
  const slackUp = await isSlackRunning();
  if (port.open && !port.isSlack) {
    // An open port is not the same as an attachable Slack: whatever answers
    // here is what `sidequest start` would drive.
    check(
      false,
      `Slack DevTools port ${config.settings.cdpPort}`,
      `open, but ${port.browser || "something"} is on it, not Slack. Quit that app, or set ` +
        "settings.cdpPort to a free port and run `sidequest start --force`.",
    );
  } else if (port.open) {
    check(
      port.matchingTargets > 0,
      `Slack DevTools port ${config.settings.cdpPort}`,
      port.matchingTargets > 0
        ? `open — ${port.matchingTargets} Slack window${port.matchingTargets === 1 ? "" : "s"} to attach to`
        : `open, but no window matches /${config.settings.targetUrlPattern}/ ` +
          `(${port.totalTargets} target${port.totalTargets === 1 ? "" : "s"} seen). ` +
          "Open a workspace in Slack, or widen settings.targetUrlPattern.",
    );
  } else if (slackUp) {
    check(
      false,
      `Slack DevTools port ${config.settings.cdpPort}`,
      "Slack is running without it. Slack only accepts the flag at startup — " +
        "quit Slack, or run `sidequest start --force` to restart it.",
    );
  } else {
    console.log(`  --   Slack DevTools port ${config.settings.cdpPort}`);
    console.log("       Slack is not running. `sidequest start` will launch it with the port open.");
  }

  const channels = Object.entries(config.channels);
  console.log(`\n  linked channels: ${channels.length}`);
  for (const [id, l] of channels) {
    try {
      const repo = await inspectRepo(l.repoPath);
      console.log(`  ok   ${id} → ${repo.root}`);
    } catch (err) {
      console.log(` FAIL  ${id} → ${l.repoPath}`);
      console.log(`       ${describeError(err).message}`);
      problems += 1;
    }
  }

  console.log(
    problems === 0
      ? "\nEverything checks out. Run `sidequest start`.\n"
      : `\n${problems} problem${problems === 1 ? "" : "s"} to fix.\n`,
  );
  if (problems > 0) process.exitCode = 1;
}

function uniqueRepoPaths(channels: Record<string, { repoPath: string }>): string[] {
  return [...new Set(Object.values(channels).map((l) => l.repoPath))];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
