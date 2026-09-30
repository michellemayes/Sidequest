import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { linkedRepoPaths } from "../config/channels.js";
import { listWorktrees, type WorktreeRecord } from "../git/worktree.js";
import { colorForPrompt } from "../warp/launcher.js";
import { headlessPaths } from "../terminals/headless.js";
import { launchTerminal, type TerminalLaunchResult } from "../terminals/launch.js";
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

/**
 * Open the terminal on a session again. If the session's pending marker is
 * still unclaimed, the agent starts on arrival; otherwise it is just a tab
 * there (or, headless, the session's answer or log).
 */
export async function openSession(config: Config, found: FoundSession): Promise<TerminalLaunchResult> {
  const { worktree, repoPath } = found;
  try {
    await stat(worktree.path);
  } catch {
    throw new UserFacingError(
      `The worktree for ${worktree.branch} is gone (${worktree.path}).`,
      "Run `sidequest clean` to drop its registration.",
    );
  }

  const scriptFile =
    config.settings.terminal === "headless"
      ? headlessPaths(worktree.path).scriptFile
      : join(worktree.path, ".sidequest", "autorun.sh");
  let scriptExists = false;
  try {
    await stat(scriptFile);
    scriptExists = true;
  } catch {
    // No launcher script; just open the directory.
  }

  const prefix = worktree.branch.split("/")[0] ?? "";
  return launchTerminal({
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
}
