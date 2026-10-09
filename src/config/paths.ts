import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all sidequest state, overridable for tests via SIDEQUEST_HOME. */
export function configRoot(): string {
  const override = process.env.SIDEQUEST_HOME?.trim();
  if (override && override.length > 0) return override;
  return join(homedir(), ".sidequest");
}

export function configFile(): string {
  return join(configRoot(), "config.json");
}

export function envFile(): string {
  return join(configRoot(), ".env");
}

/** Default parent directory for generated worktrees. */
export function defaultWorktreesRoot(): string {
  return join(configRoot(), "worktrees");
}

export function shellHookFile(): string {
  return join(configRoot(), "shell-hook.sh");
}

/** PID file for the background daemon started by `sidequest start`. */
export function daemonPidFile(): string {
  return join(configRoot(), "sidequest.pid");
}

/** Held by the running daemon, so a second one cannot attach beside it. */
export function daemonLockFile(): string {
  return join(configRoot(), "sidequest.lock");
}

/** Log file the background daemon's output goes to. */
export function daemonLogFile(): string {
  return join(configRoot(), "sidequest.log");
}

/** Every session Sidequest has started, newest last. */
export function historyFile(): string {
  return join(configRoot(), "history.json");
}

/** The Unix socket the Mac app talks to the running daemon on. */
export function controlSocketFile(): string {
  return join(configRoot(), "control.sock");
}

/** What settings sync last agreed with Slack, and the links it could not place here yet. */
export function syncStateFile(): string {
  return join(configRoot(), "sync.json");
}
