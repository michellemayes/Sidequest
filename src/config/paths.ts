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
