import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { linkedRepoPaths } from "../config/channels.js";
import { listWorktrees, type WorktreeRecord } from "../git/worktree.js";
import { colorForPrompt } from "../warp/launcher.js";
import { armContinue } from "../warp/autorun.js";
import { headlessPaths } from "../terminals/headless.js";
import { launchTerminal } from "../terminals/launch.js";
import { sessionHost, type TerminalId } from "../terminals/registry.js";
import { agentConfigFor, resolveAgent } from "../agents/agents.js";
import { openUri } from "../util/openUri.js";
import { tabTitle, warpConfigName } from "./naming.js";
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
  /** Where it opened, e.g. "Warp", "iTerm2" or "the Claude app". */
  host: string;
  /** The terminal it opened in; absent for an agent in a desktop app. */
  terminal?: TerminalId;
  /** How: the Warp strategy that worked, a terminal's tag, or the agent's id for an app. */
  strategy: string;
  /** Anything worth telling the user, e.g. how to attach to a new tmux session. */
  note?: string;
  /** Whether the agent claimed a still-pending session; null when there was none. */
  agentStarted: boolean | null;
}

/**
 * Open a session again. In a terminal: if the session's pending marker is
 * still unclaimed, the agent starts on arrival; if it has already run, the
 * agent picks up its last conversation there, where the agent can (otherwise
 * it is just a tab). Headless opens the session's answer or log. For an agent in a
 * desktop app: a new session in the app, in the worktree (the links cannot
 * reach back into an earlier one), whatever the terminal setting.
 * `agentId` is the agent the session was started with; empty means settings.agent.
 * With `followUp`, the session's script was armed for one (see followUpSession).
 */
export async function openSession(
  config: Config,
  found: FoundSession,
  agentId = "",
  options: { followUp?: boolean } = {},
): Promise<ReopenResult> {
  const { worktree, repoPath } = found;
  try {
    await stat(worktree.path);
  } catch {
    throw new UserFacingError(
      `The worktree for ${worktree.branch} is gone (${worktree.path}).`,
      "Run `sidequest clean` to drop its registration.",
    );
  }

  // The agent the session was started with, which its prompt may have picked.
  const agent = resolveAgent(agentConfigFor(config.settings.agent, agentId));
  if (agent.app) {
    await openUri(agent.app.newSessionUri(worktree.path), agent.host, `Is ${agent.host} installed? \`sidequest doctor\` checks.`);
    return { host: agent.host, strategy: agent.id, agentStarted: null };
  }

  const terminal = config.settings.terminal;
  const scriptFile =
    terminal === "headless"
      ? headlessPaths(worktree.path).scriptFile
      : join(worktree.path, ".sidequest", "autorun.sh");
  let scriptExists = false;
  try {
    await stat(scriptFile);
    scriptExists = true;
  } catch {
    // No launcher script; just open the directory.
  }
  // A session that already ran carries on its conversation. Headless has
  // nothing to carry on: it opens the answer instead.
  if (scriptExists && terminal !== "headless" && !options.followUp) await armContinue(worktree.path);

  const prefix = worktree.branch.split("/")[0] ?? "";
  const launch = await launchTerminal({
    settings: config.settings,
    session: {
      name: warpConfigName(worktree.branch),
      color: colorForPrompt(prefix),
      title: tabTitle(prefix || "sidequest", basename(repoPath)),
      cwd: worktree.path,
      script: scriptExists ? scriptFile : null,
      pendingFile: join(worktree.path, ".sidequest", "pending"),
    },
  });
  return {
    host: sessionHost(agent, terminal),
    terminal: launch.terminal,
    strategy: launch.strategy,
    agentStarted: launch.agentStarted,
    ...(launch.note ? { note: launch.note } : {}),
  };
}
