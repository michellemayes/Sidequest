import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { devtoolsVersion } from "./client.js";
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
  try {
    await devtoolsVersion(port);
    return true;
  } catch {
    return false;
  }
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
}): Promise<LaunchResult> {
  if (platform() !== "darwin") {
    throw new UserFacingError("ccslack drives the macOS Slack desktop app; this is not macOS.");
  }

  if (await isDebugPortOpen(options.cdpPort)) {
    return { started: false, reason: "already-listening" };
  }

  if (await isSlackRunning()) {
    if (!options.force) {
      throw new UserFacingError(
        `Slack is running without --remote-debugging-port=${options.cdpPort}.`,
        "Quit Slack and try again, or re-run with --force to have ccslack quit it for you.",
      );
    }
    if (!(await quitSlack())) {
      throw new UserFacingError(
        "Slack did not quit in time.",
        "Quit it by hand and run `ccslack start` again.",
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
