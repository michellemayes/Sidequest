import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { devtoolsVersion, isAttachableTarget, listTargets } from "./client.js";
import { run, succeeds } from "../util/exec.js";
import { UserFacingError } from "../util/errors.js";
import { platform } from "../util/platform.js";
import { sleep } from "../util/async.js";
import { configRoot } from "../config/paths.js";
import { ensureSidequestProfile, sidequestSlackProfile } from "./slackProfile.js";

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

  if (await waitForSlackToExit(timeoutMs)) return true;

  // A Slack that is still starting up can miss the Apple Event; the daemon
  // relaunches exactly that kind of Slack, so fall back to asking the process.
  await succeeds("/usr/bin/pkill", ["-TERM", "-x", "Slack"]);
  return waitForSlackToExit(5000);
}

async function waitForSlackToExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSlackRunning())) return true;
    await sleep(400);
  }
  return false;
}

export interface LaunchResult {
  started: boolean;
  /** "not-listening": Slack could not be brought up with its port, and the daemon started without it. */
  reason?: "already-listening" | "not-listening";
  app?: string;
  /** Sidequest's own Slack profile, when Slack refused its port on the default one. */
  profile?: string;
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

  const profile = await startWithPort(options.cdpPort, macLaunchDeps(app));
  return { started: true, app, ...(profile ? { profile } : {}) };
}

/**
 * Start Slack with its port open; resolves to the profile it runs on.
 *
 * A Slack that quits at once instead of listening has refused the port on its
 * default profile (Slack 4.53 and later), so it is started again on
 * Sidequest's own, which every later launch then uses.
 */
export async function startWithPort(port: number, deps: LaunchDeps): Promise<string | undefined> {
  let profile = deps.existingProfile();
  let attempt = await deps.start(port, profile);
  if (attempt.kind === "exited" && !profile) {
    profile = await deps.createProfile();
    attempt = await deps.start(port, profile);
  }
  if (attempt.kind === "listening") return profile;

  const said = reason(attempt.output);
  throw new UserFacingError(
    attempt.kind === "exited"
      ? `Slack quit without opening 127.0.0.1:${port}${said ? `: ${said}` : "."}`
      : `Slack started but nothing is listening on 127.0.0.1:${port}.`,
    `Slack's own output is in ${launchLogFile()}.`,
  );
}

export type StartOutcome = { kind: "listening" } | { kind: "exited" | "timed-out"; output: string };

/** The parts of a launch that touch the Mac; swapped out in tests. */
export interface LaunchDeps {
  /** Sidequest's own Slack profile, once one has been made. */
  existingProfile(): string | undefined;
  createProfile(): Promise<string>;
  /** Start Slack and wait for its port, or for it to quit first. */
  start(port: number, profile: string | undefined): Promise<StartOutcome>;
}

function macLaunchDeps(app: string): LaunchDeps {
  return {
    existingProfile() {
      const dir = sidequestSlackProfile();
      return existsSync(dir) ? dir : undefined;
    },
    createProfile: () => ensureSidequestProfile(),
    async start(port, profile) {
      const log = launchLogFile();
      mkdirSync(dirname(log), { recursive: true });
      // A file, not a pipe: Slack outlives the daemon, and a closed pipe
      // would end it on its next write.
      const out = openSync(log, "w");
      const args = [`--remote-debugging-port=${port}`];
      if (profile) args.push(`--user-data-dir=${profile}`);
      const child = spawn(join(app, "Contents", "MacOS", "Slack"), args, { detached: true, stdio: ["ignore", out, out] });
      closeSync(out);
      let exited = false;
      child.once("exit", () => { exited = true; });
      child.once("error", () => { exited = true; });
      child.unref();

      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (await isDebugPortOpen(port)) return { kind: "listening" };
        if (exited) return { kind: "exited", output: readLog(log) };
        await sleep(500);
      }
      return { kind: "timed-out", output: readLog(log) };
    },
  };
}

export function launchLogFile(): string {
  return join(configRoot(), "slack-launch.log");
}

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(-8192);
  } catch {
    return "";
  }
}

function reason(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /refus|not allowed|error/i.test(l)) ?? "").slice(0, 300);
}

