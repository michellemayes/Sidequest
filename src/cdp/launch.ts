import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { devtoolsVersion, isAttachableTarget, listTargets } from "./client.js";
import { run, succeeds } from "../util/exec.js";
import { UserFacingError } from "../util/errors.js";
import { platform } from "../util/platform.js";

const APP_CANDIDATES = [
  "/Applications/Slack.app",
  join(homedir(), "Applications", "Slack.app"),
];

export function findSlackApp(): string | null {
  for (const candidate of APP_CANDIDATES) {
    if (existsSync(join(candidate, "Contents", "MacOS", "Slack"))) return candidate;
  }
  return null;
}

/** True when something is already serving the DevTools endpoint on that port. */
export async function isDebugPortOpen(port: number): Promise<boolean> {
  return (await inspectDebugPort(port)).open;
}

/** Who is answering on a DevTools port, and whether it is Slack. */
export interface PortInspection {
  open: boolean;
  /** The `Browser` string the endpoint reports, e.g. "Chrome/124.0.6367.243". */
  browser: string;
  userAgent: string;
  /** Targets a sweep would attach to. */
  matchingTargets: number;
  totalTargets: number;
  /** False when something other than Slack owns the port. */
  isSlack: boolean;
}

/**
 * Find out what owns a DevTools port.
 *
 * A port that answers is not the same as Slack being there: Chrome started
 * with --remote-debugging-port, another Electron app, or a leftover headless
 * browser all reply on 9222 exactly as Slack does. Attaching to one of those
 * succeeds at every step and puts the overlay nowhere, so the distinction is
 * worth drawing before `start` reports success.
 */
export async function inspectDebugPort(
  port: number,
  targetUrlPattern?: string,
): Promise<PortInspection> {
  let version: Record<string, string>;
  try {
    version = await devtoolsVersion(port);
  } catch {
    return { open: false, browser: "", userAgent: "", matchingTargets: 0, totalTargets: 0, isSlack: false };
  }

  const browser = version.Browser ?? "";
  const userAgent = version["User-Agent"] ?? "";

  let matchingTargets = 0;
  let totalTargets = 0;
  if (targetUrlPattern) {
    try {
      const pattern = new RegExp(targetUrlPattern, "i");
      const targets = await listTargets(port);
      totalTargets = targets.length;
      matchingTargets = targets.filter((t) => isAttachableTarget(t, pattern)).length;
    } catch {
      // The endpoint answered /json/version but not /json/list; fall back to
      // what the version strings say.
    }
  }

  return {
    open: true,
    browser,
    userAgent,
    matchingTargets,
    totalTargets,
    // Slack's Electron build puts "Slack/<version>" in its User-Agent. A
    // window already on a Slack URL settles it either way, which also covers
    // a build whose User-Agent says nothing.
    isSlack: matchingTargets > 0 || /slack/i.test(`${browser} ${userAgent}`),
  };
}

export async function isSlackRunning(): Promise<boolean> {
  return succeeds("/usr/bin/pgrep", ["-x", "Slack"]);
}

export async function quitSlack(timeoutMs = 15_000): Promise<boolean> {
  try {
    await run("/usr/bin/osascript", ["-e", 'tell application "Slack" to quit']);
  } catch {
    // Slack may not be scriptable, or may already be gone.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSlackRunning())) return true;
    await sleep(400);
  }
  return false;
}

export interface LaunchResult {
  started: boolean;
  reason?: string;
  app?: string;
}

/**
 * Make sure Slack is running with its DevTools port open.
 *
 * Slack only accepts `--remote-debugging-port` at process start, so an
 * already-running Slack has to be restarted. That is disruptive enough to
 * require `force` rather than doing it behind the user's back.
 */
export async function launchSlack(options: {
  cdpPort: number;
  force?: boolean;
  targetUrlPattern?: string;
}): Promise<LaunchResult> {
  if (platform() !== "darwin") {
    throw new UserFacingError("Sidequest drives the macOS Slack desktop app; this is not macOS.");
  }

  const port = await inspectDebugPort(options.cdpPort, options.targetUrlPattern);
  if (port.open) {
    if (!port.isSlack) {
      throw new UserFacingError(
        `Something other than Slack is listening on 127.0.0.1:${options.cdpPort}` +
          `${port.browser ? ` (${port.browser})` : ""}.`,
        "Sidequest would attach to that instead of Slack and draw nothing. Quit it, or " +
          "set settings.cdpPort in ~/.sidequest/config.json to a free port and run " +
          "`sidequest start --force` so Slack is restarted on it.",
      );
    }
    return { started: false, reason: "already-listening" };
  }

  if (await isSlackRunning()) {
    if (!options.force) {
      throw new UserFacingError(
        `Slack is running without --remote-debugging-port=${options.cdpPort}.`,
        "Quit Slack and try again, or re-run with --force to have Sidequest quit it for you.",
      );
    }
    if (!(await quitSlack())) {
      throw new UserFacingError(
        "Slack did not quit in time.",
        "Quit it by hand and run `sidequest start` again.",
      );
    }
  }

  const app = findSlackApp();
  if (!app) {
    throw new UserFacingError(
      `Could not find Slack.app in ${APP_CANDIDATES.join(" or ")}.`,
      "Install the Slack desktop app, or move it to /Applications.",
    );
  }

  const child = spawn(join(app, "Contents", "MacOS", "Slack"), [
    `--remote-debugging-port=${options.cdpPort}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await isDebugPortOpen(options.cdpPort)) return { started: true, app };
    await sleep(500);
  }

  throw new UserFacingError(
    `Slack started but nothing is listening on 127.0.0.1:${options.cdpPort}.`,
    "Slack may have refused the flag, or another Slack instance was already running.",
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
