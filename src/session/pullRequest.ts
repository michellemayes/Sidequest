/**
 * A pull request for a session's branch, in one click from Slack.
 *
 * The prompts ask the agent to commit, not to push: what leaves the machine
 * is yours to decide. Once you have looked and want it reviewed, this pushes
 * the branch and opens a draft pull request with `gh`, titled for the first
 * commit and described by the agent's reply for the thread, which already
 * says what changed and why. A draft, because the agent wrote it and a
 * person should mark it ready.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandError, run } from "../util/exec.js";
import { isDirectory } from "../util/fs.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import { SESSION_DIR } from "../warp/autorun.js";
import type { HistoryEntry } from "./history.js";
import { readResult } from "./result.js";

export interface OpenedPullRequest {
  url: string;
  /** False when the branch already had one, which is what was found. */
  created: boolean;
}

/** Plenty for a description; GitHub's own limit is far above this. */
const MAX_BODY_CHARS = 20_000;

/**
 * Push a session's branch and open a draft pull request for it. A branch
 * that already has one is not given a second: that one is returned.
 */
export async function openPullRequest(entry: HistoryEntry): Promise<OpenedPullRequest> {
  const cwd = entry.worktreePath;
  if (!(await isDirectory(cwd))) {
    throw new UserFacingError(`The worktree for ${entry.branch} is gone.`, "It was cleaned up; there is nothing to push.");
  }

  const subjects = await commitSubjects(entry);
  if (subjects.length === 0) {
    throw new UserFacingError(
      `${entry.branch} has nothing committed yet.`,
      "Ask the agent to commit its work, then try again.",
    );
  }

  try {
    await run("git", ["push", "--set-upstream", "origin", entry.branch], { cwd, timeoutMs: 120_000 });
  } catch (err) {
    const detail = err instanceof CommandError ? err.stderr.trim() || err.message : String(err);
    throw new UserFacingError(`Could not push ${entry.branch}: ${detail}`, "Push it from the worktree to see why.");
  }

  const bodyFile = join(cwd, SESSION_DIR, "pr-body.md");
  await mkdir(join(cwd, SESSION_DIR), { recursive: true });
  await writeFile(bodyFile, await pullRequestBody(entry, subjects), "utf8");
  const base = entry.baseBranch?.trim();
  const args = [
    "pr", "create", "--draft",
    "--head", entry.branch,
    ...(base ? ["--base", base] : []),
    "--title", subjects[0]!,
    "--body-file", bodyFile,
  ];
  try {
    const { stdout } = await run("gh", args, { cwd, timeoutMs: 60_000 });
    const url = pullRequestUrl(stdout);
    if (!url) throw new UserFacingError("gh opened a pull request but did not say where.", "Run `gh pr view` in the worktree.");
    log.info(`opened ${url} for ${entry.branch}`);
    return { url, created: true };
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    // Someone (or the agent) got there first: that one is the answer.
    const existing = /already exists/i.test(err.stderr) ? pullRequestUrl(err.stderr) : null;
    if (existing) return { url: existing, created: false };
    if (err.code === null && /not installed/.test(err.stderr)) {
      throw new UserFacingError(
        "Opening a pull request needs the GitHub CLI.",
        "Install it (https://cli.github.com) and run `gh auth login`.",
      );
    }
    throw new UserFacingError(`gh could not open a pull request: ${err.stderr.trim() || err.message}`, "Is `gh auth status` signed in?");
  }
}

/** The branch's own commits, oldest first, by subject. */
async function commitSubjects(entry: HistoryEntry): Promise<string[]> {
  const base = entry.baseBranch?.trim();
  for (const ref of base ? [`origin/${base}`, base] : ["origin/HEAD", "origin/main", "main", "origin/master", "master"]) {
    try {
      const { stdout } = await run("git", ["log", "--reverse", "--format=%s", `${ref}..HEAD`], {
        cwd: entry.worktreePath,
        timeoutMs: 15_000,
      });
      return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      // Not a ref here; try the next.
    }
  }
  return [];
}

/**
 * What the pull request says: the agent's reply for the thread when it left
 * one, else the commits; and, last, that it came from Slack. Not the link or
 * the channel, which would put a private workspace's names in what may be a
 * public repo.
 */
export async function pullRequestBody(entry: HistoryEntry, subjects: string[]): Promise<string> {
  const result = await readResult(entry.worktreePath);
  const summary = result?.text.trim() || subjects.map((s) => `- ${s}`).join("\n");
  const by = entry.agentLabel ? ` by ${entry.agentLabel}` : "";
  const footer = `\n\n---\n_${entry.promptLabel || "Session"} started from a Slack message, worked${by} with [Sidequest](https://github.com/michellemayes/Sidequest)._\n`;
  return summary.slice(0, MAX_BODY_CHARS) + footer;
}

/** The last pull request URL in gh's output. */
export function pullRequestUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/\S+\/pull\/\d+/g);
  return urls ? urls[urls.length - 1]! : null;
}
