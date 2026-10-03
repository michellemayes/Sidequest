import { readFile, stat } from "node:fs/promises";
import { describeAgent, describeHeadless, type ResolvedAgent } from "../agents/agents.js";
import type { Config, TerminalId } from "../config/schema.js";
import { finishedWorktrees, PILE_UP_AT } from "../session/cleanup.js";
import { terminalDefinition } from "../terminals/registry.js";

/**
 * A line on finished worktrees piling up, or null while there's no pile. Only
 * said when autoClean is off; with it on, the daemon takes care of them.
 */
export async function pileUpNudge(config: Config): Promise<string | null> {
  if (config.settings.autoClean) return null;
  const finished = await finishedWorktrees(config).catch(() => []);
  if (finished.length < PILE_UP_AT) return null;
  return (
    `${finished.length} merged worktrees have sat untouched for over ${config.settings.autoCleanAfterDays} days. ` +
    "Run `sidequest clean`, or set settings.autoClean to true and the daemon removes them for you."
  );
}

/** How the active agent is run: its headless command line when that's what sessions use. */
export function runsAs(config: Config, agent: ResolvedAgent): string {
  if (!agent.app && config.settings.terminal === "headless") {
    return describeHeadless(agent) || "no headless mode; sessions will fail until you switch";
  }
  return describeAgent(agent);
}

/**
 * The terminal setting as `status`, `list` and `doctor` show it. An agent in
 * a desktop app never uses it, so say so rather than name a terminal that
 * won't open.
 */
export function terminalSummary(id: TerminalId, agent: ResolvedAgent): string {
  const label = terminalDefinition(id).label;
  return agent.app ? `${label}, unused: ${agent.label} opens in ${agent.host}` : label;
}

export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function readFileOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
