import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { linkedRepoPaths } from "../config/channels.js";
import { listWorktrees, type WorktreeRecord } from "../git/worktree.js";
import { colorForPrompt, launchWarp } from "../warp/launcher.js";
import { resolveAgent } from "../agents/agents.js";
import { openUri } from "../util/openUri.js";
import { warpConfigName } from "./naming.js";
import { UserFacingError } from "../util/errors.js";

export interface FoundSession {
  worktree: WorktreeRecord;
  repoPath: string;
}

/**
 * A worktree Sidequest created, by branch name or path. `extraRepos` covers a
 * session whose channel has since been unlinked: history still knows its repo.
 */
export async function findSession(
  config: Config,
  ref: string,
  extraRepos: string[] = [],
): Promise<FoundSession | null> {
  const repos = [...new Set([...linkedRepoPaths(config), ...extraRepos])];
  const wanted = resolve(ref);
  for (const repoPath of repos) {
    let worktrees: WorktreeRecord[];
    try {
      worktrees = await listWorktrees(repoPath);
    } catch {
      continue;
    }
    const match = worktrees
      .filter((w) => !w.isMain && w.path.startsWith(config.settings.worktreesRoot))
      .find((w) => w.branch === ref || w.path === wanted);
    if (match) return { worktree: match, repoPath };
  }
  return null;
}

export interface ReopenResult {
  /** Where it opened, e.g. "Warp" or "the Claude app". */
  host: string;
  /** How: the Warp strategy that worked, or the agent's id for an app. */
  strategy: string;
  /** Whether the agent claimed a still-pending session; null when there was none. */
  agentStarted: boolean | null;
}

/**
 * Open a session again. In Warp: if the session's pending marker is still
 * unclaimed, the agent starts on arrival; otherwise it is just a tab there.
 * For an agent in a desktop app: a new session in the app, in the worktree
 * (the links cannot reach back into an earlier one).
 */
export async function openSession(config: Config, found: FoundSession): Promise<ReopenResult> {
  const { worktree, repoPath } = found;
  try {
    await stat(worktree.path);
  } catch {
    throw new UserFacingError(
      `The worktree for ${worktree.branch} is gone (${worktree.path}).`,
      "Run `sidequest clean` to drop its registration.",
    );
  }

  const agent = resolveAgent(config.settings.agent);
  if (agent.app) {
    await openUri(agent.app.newSessionUri(worktree.path), agent.host, `Is ${agent.host} installed? \`sidequest doctor\` checks.`);
    return { host: agent.host, strategy: agent.id, agentStarted: null };
  }

  const scriptFile = join(worktree.path, ".sidequest", "autorun.sh");
  let scriptExists = false;
  try {
    await stat(scriptFile);
    scriptExists = true;
  } catch {
    // No launcher script; just open the directory.
  }

  const prefix = worktree.branch.split("/")[0] ?? "";
  const launch = await launchWarp({
    strategy: scriptExists ? config.settings.warpStrategy : "new_tab",
    preview: config.settings.warpPreview,
    spec: {
      name: warpConfigName(worktree.branch),
      color: colorForPrompt(prefix),
      cwd: worktree.path,
      command: scriptExists ? scriptFile : "true",
    },
    pendingFile: join(worktree.path, ".sidequest", "pending"),
  });
  return { host: "Warp", strategy: launch.strategy, agentStarted: launch.agentStarted };
}
