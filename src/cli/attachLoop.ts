import { resolveAgent } from "../agents/agents.js";
import { Attacher } from "../cdp/attacher.js";
import { SlackKeeper } from "../cdp/keeper.js";
import type { LaunchResult } from "../cdp/launch.js";
import { configFile, controlSocketFile } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { loadConfig } from "../config/store.js";
import { clearDaemonRecord, lockDaemon, unlockDaemon, writeDaemonRecord } from "../daemon.js";
import { AutoCleaner } from "../session/cleanup.js";
import { createAppHandler } from "../control/app.js";
import { ControlServer } from "../control/server.js";
import { builtCommit, installRoot } from "../update.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import { plural } from "./shared.js";

/** How long a stopping daemon waits for sessions that are starting; under STOP_GRACE_MS. */
const DAEMON_DRAIN_MS = 6_000;

export async function runAttacherLoop(options: {
  launch: LaunchResult;
  config: Config;
}): Promise<void> {
  const { launch, config } = options;
  const { cdpPort, targetUrlPattern } = config.settings;
  const daemonized = Boolean(process.env.SIDEQUEST_DAEMON);
  const agentLabel = resolveAgent(config.settings.agent).label;

  // The daemon is long-lived and mostly does background work nobody awaits,
  // so one promise that slips through without a catch should cost a line in
  // the log, not the overlay in every Slack window.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection (the daemon keeps running)", reason);
  });
  // A synchronous throw that reached the top is different: whatever it
  // interrupted is half done, and a daemon in that state can go on answering
  // clicks wrongly. Log it and stop; `status` then says the daemon is not
  // running, and `start` brings back a clean one.
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception; stopping the daemon", err);
    if (daemonized) void clearDaemonRecord().finally(() => process.exit(1));
    else process.exit(1);
  });

  // Held for as long as this process attaches: a second daemon, or a
  // --foreground run beside one, would put a second overlay on every window.
  const holder = await lockDaemon();
  if (holder !== null) {
    throw new UserFacingError(
      `Another Sidequest daemon (pid ${holder.pid}) is already attached to Slack, so this one is exiting.`,
      "Run `sidequest status` to check on it, or `sidequest stop` to stop it.",
    );
  }

  if (daemonized) await writeDaemonRecord((await builtCommit(installRoot())) ?? "");
  // Until the banner is out, `start` reports the attach state itself; a running
  // commentary before it would say the same thing twice, out of order.
  let booted = false;
  // Set below, once the attacher it answers through exists. Until then the
  // hooks have nobody to tell.
  let control: ControlServer | null = null;
  let sessionsTimer: NodeJS.Timeout | null = null;
  /** The app is told sessions moved; a burst of changes is one event. */
  const sessionsChanged = (): void => {
    if (!control || sessionsTimer) return;
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null;
      control?.broadcast("sessions");
    }, 250);
  };
  const attacher = new Attacher({
    cdpPort,
    targetUrlPattern,
    onStatuses: sessionsChanged,
    onConfigPushed: () => {
      control?.broadcast("config");
      sessionsChanged();
    },
    deliverNotices: (notices) => {
      if (!control?.takesNotices) return false;
      for (const notice of notices) control.broadcast("notice", { ...notice });
      return true;
    },
    onEvent: (event) => {
      if (event.type === "attached" || event.type === "detached") control?.broadcast("health");
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
        case "agent-not-started":
          console.error(`${event.branch} in #${event.channel}: ${event.message}`);
          break;
        case "link":
          console.log(`linked #${event.channel} → ${event.message}`);
          break;
        case "unlink":
          console.log(`unlinked #${event.channel}${event.message ? ` from ${event.message}` : ""}`);
          break;
        case "sync":
          console.log(`settings sync: ${event.message}`);
          break;
        case "attach-error":
        case "poll-error":
        case "sync-error":
        case "ask-error":
        case "config-error":
        case "status-error":
          log.warn(`${event.type}: ${event.message}`);
          break;
        default:
          log.debug(event.type, event);
      }
    },
  });

  await attacher.start();

  const server = new ControlServer({ path: controlSocketFile(), handle: createAppHandler(attacher) });
  try {
    await server.listen();
    control = server;
  } catch (err) {
    // The Slack overlay works without it; only the Mac app needs the socket.
    log.warn(`could not open the control socket for the Mac app: ${describeError(err).message}`);
  }

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

  // Always started: it reads the config each tick, so turning autoClean on
  // later needs no restart, and while it is off a tick does nothing else.
  const cleaner = new AutoCleaner({ loadConfig });
  cleaner.start();

  const linked = Object.keys(config.channels).length;
  console.log(
    launch.started
      ? "Started Slack with its DevTools port open."
      : "Slack was already listening on its DevTools port.",
  );
  console.log(`  config:    ${configFile()}`);
  console.log(`  worktrees: ${config.settings.worktreesRoot}`);
  console.log(`  channels:  ${linked} linked`);
  if (config.settings.autoClean) {
    console.log(`  cleanup:   merged worktrees idle over ${config.settings.autoCleanAfterDays} days are removed`);
  }
  console.log(`  windows:   ${attacher.attachedCount} attached`);

  if (attacher.attachedCount === 0) {
    const { targets } = attacher.lastSweep;
    console.log(
      `\nNo Slack window is attached yet. The DevTools endpoint on ${cdpPort} reports ` +
        `${plural(targets, "target")}, none matching /${targetUrlPattern}/.\n` +
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

  let stopping = false;
  const shutdown = (): void => {
    // A second Ctrl-C (or signal) while a session finishes means now.
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\nstopping…");
    keeper.stop();
    cleaner.stop();
    void (async () => {
      // A click being handled when the stop came would otherwise lose its
      // answer, or be cut off between the worktree and the terminal.
      if (!(await attacher.drain(DAEMON_DRAIN_MS))) {
        console.log("a session was still starting; stopping anyway");
      }
      attacher.stop();
      await control?.close();
      await unlockDaemon();
      if (daemonized) await clearDaemonRecord();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
