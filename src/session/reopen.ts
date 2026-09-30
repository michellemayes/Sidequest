import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { listWorktrees, type WorktreeRecord } from "../git/worktree.js";
import { colorForPrompt, launchWarp, type LaunchResult } from "../warp/launcher.js";
import { warpConfigName } from "./naming.js";
import { UserFacingError } from "../util/errors.js";

export interface FoundSession {
  worktree: WorktreeRecord;
  repoPath: string;
}

function uniqueRepoPaths(config: Config): string[] {
  return [...new Set(Object.values(config.channels).map((l) => l.repoPath))];
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
  const repos = [...new Set([...uniqueRepoPaths(config), ...extraRepos])];
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
 * Open Warp on a session again. If the session's pending marker is still
 * unclaimed, the agent starts on arrival; otherwise it is just a tab there.
 */
export async function openSession(config: Config, found: FoundSession): Promise<LaunchResult> {
  const { worktree, repoPath } = found;
  try {
    await stat(worktree.path);
  } catch {
    throw new UserFacingError(
      `The worktree for ${worktree.branch} is gone (${worktree.path}).`,
      "Run `sidequest clean` to drop its registration.",
    );
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
      title: `${worktree.branch} · ${basename(repoPath)}`,
      color: colorForPrompt(prefix),
      cwd: worktree.path,
      command: scriptExists ? scriptFile : "true",
    },
    pendingFile: join(worktree.path, ".sidequest", "pending"),
  });
  return launch;
}
