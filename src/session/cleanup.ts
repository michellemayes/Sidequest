/**
 * Removing finished worktrees, for `sidequest clean` and for the daemon.
 *
 * Both run through `sweepWorktrees`, so the safety rules live in exactly one
 * place and the automatic sweep can never be looser than the manual one:
 *
 * - only worktrees under settings.worktreesRoot, never one the user made by
 *   hand elsewhere in the same repo;
 * - only branches merged into the base, unless the caller passes `all`;
 * - never uncommitted changes (`git worktree remove` refuses them) unless the
 *   caller passes `force`;
 * - the branch goes too only with pruneBranchesOnClean, and then only through
 *   `git branch -d`, which keeps a branch holding commits the base lacks.
 *
 * The daemon never passes `all` or `force`. What it and `clean` both add is
 * `minIdleMs`: a merged branch is not the same as a finished session.
 * Investigate, Review and Ask commit nothing, so their branch is "merged" (it
 * sits on the base) from the moment it is cut, while the agent may still be
 * working in it. Leaving a worktree alone until nothing has touched it for a
 * while is what keeps the sweep from pulling a directory out from under an
 * open Warp tab. The daemon waits days; `clean` waits an hour, unless told
 * `--recent`.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { allLinks, linkedRepoPaths } from "../config/channels.js";
import { inspectRepo, isMergedInto } from "../git/repo.js";
import { listWorktrees, pruneWorktrees, removeWorktree, type WorktreeRecord } from "../git/worktree.js";
import { run } from "../util/exec.js";
import { describeError } from "../util/errors.js";
import { log } from "../util/log.js";
import { SESSION_DIR } from "../warp/autorun.js";

export type SweepOutcome =
  /** Removed (or, on a dry run, would be removed). */
  | { kind: "removed"; repoPath: string; branch: string; path: string; removedBranch: boolean }
  | { kind: "not-merged"; repoPath: string; branch: string; path: string; base: string }
  /** Merged, but touched more recently than `minIdleMs` allows. */
  | { kind: "recent"; repoPath: string; branch: string; path: string; idleMs: number }
  | { kind: "dirty"; repoPath: string; branch: string; path: string }
  /** The linked repo itself could not be read (moved, deleted, not a repo). */
  | { kind: "repo-error"; repoPath: string; message: string };

export interface SweepOptions {
  /** Remove worktrees with uncommitted changes too. Only `clean --force`. */
  force?: boolean;
  /** Ignore whether the branch is merged. Only `clean --all`. */
  all?: boolean;
  /** Keep a merged worktree touched less than this long ago. */
  minIdleMs?: number;
  /** Decide, but remove nothing. Counts what a sweep would take. */
  dryRun?: boolean;
  /** Called as each worktree is decided, so `clean` can print as it goes. */
  onOutcome?: (outcome: SweepOutcome) => void;
  /** The clock, injectable so tests can age a worktree without waiting. */
  now?: () => number;
}

/** Go through every linked repo's Sidequest worktrees and remove the finished ones. */
export async function sweepWorktrees(config: Config, options: SweepOptions = {}): Promise<SweepOutcome[]> {
  const outcomes: SweepOutcome[] = [];
  const report = (outcome: SweepOutcome): void => {
    outcomes.push(outcome);
    options.onOutcome?.(outcome);
  };
  const now = options.now ?? Date.now;

  for (const repoPath of linkedRepoPaths(config)) {
    let base: string;
    let worktrees: WorktreeRecord[];
    try {
      if (!options.dryRun) await pruneWorktrees(repoPath);
      const repo = await inspectRepo(repoPath);
      base = baseBranchFor(config, repoPath) || repo.defaultBranch;
      // A prunable entry's directory is already gone: the prune above drops
      // it, and a dry run should not count it as something left to clean.
      worktrees = (await listWorktrees(repoPath)).filter(
        (w) => !w.isMain && !w.isPrunable && w.path.startsWith(config.settings.worktreesRoot),
      );
    } catch (err) {
      // One linked repo that has moved should not stop the others being swept.
      report({ kind: "repo-error", repoPath, message: describeError(err).message });
      continue;
    }

    for (const w of worktrees) {
      const at = { repoPath, branch: w.branch, path: w.path };
      if (!options.all && !(await isMergedInto(repoPath, w.branch, base))) {
        report({ kind: "not-merged", ...at, base });
        continue;
      }

      // Checked per worktree and last, right before removing it, so it says
      // how things are now rather than when a sweep that has spent a while
      // on other worktrees began.
      if (options.minIdleMs !== undefined && options.minIdleMs > 0) {
        const idleMs = now() - (await lastActivity(w.path));
        if (idleMs < options.minIdleMs) {
          report({ kind: "recent", ...at, idleMs });
          continue;
        }
      }

      if (options.dryRun) {
        report({ kind: "removed", ...at, removedBranch: false });
        continue;
      }

      const result = await removeWorktree(repoPath, w.path, {
        force: options.force,
        deleteBranch: config.settings.pruneBranchesOnClean ? w.branch : undefined,
      });
      if (!result.removedWorktree) {
        report({ kind: "dirty", ...at });
        continue;
      }
      report({ kind: "removed", ...at, removedBranch: result.removedBranch });
    }
  }
  return outcomes;
}

/**
 * When the worktree was last touched, in epoch ms: the newest of its last
 * commit, its top-level directory, and its session files. That catches a new
 * commit, a file created or deleted at the top, and a session being started or
 * reopened, which is enough to tell "someone is on this" from "abandoned"
 * without walking the tree. Anything unreadable just doesn't count.
 */
export async function lastActivity(worktreePath: string): Promise<number> {
  const [commit, ...mtimes] = await Promise.all([
    run("git", ["log", "-1", "--format=%ct"], { cwd: worktreePath }).then(
      (r) => Number.parseInt(r.stdout.trim(), 10) * 1000,
      () => 0,
    ),
    ...[worktreePath, join(worktreePath, SESSION_DIR)].map((p) =>
      stat(p).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  ]);
  return Math.max(Number.isFinite(commit) ? commit : 0, ...mtimes);
}

/** The base branch configured for whichever channel links this repo. */
export function baseBranchFor(config: Config, repoPath: string): string {
  for (const link of allLinks(config)) {
    if (link.repoPath === repoPath && link.baseBranch.trim()) return link.baseBranch.trim();
  }
  return "";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long `clean` leaves a worktree alone after anything touched it. Long
 * enough to cover a session still being created or read through, short
 * enough that `clean` right after finishing the day's work still clears it.
 */
export const CLEAN_MIN_IDLE_MS = 60 * 60 * 1000;

/** The sweep `sidequest clean` runs, from its flags. */
export function cleanSweepOptions(flags: { force?: boolean; all?: boolean; recent?: boolean }): SweepOptions {
  return {
    force: flags.force,
    all: flags.all,
    minIdleMs: flags.recent ? undefined : CLEAN_MIN_IDLE_MS,
  };
}

/**
 * How many finished worktrees make a pile worth mentioning. A couple is just
 * this week's work; this many means nobody is cleaning up.
 */
export const PILE_UP_AT = 5;

/**
 * Worktrees an automatic sweep would take right now, for the nudges in
 * `status`, `doctor` and `start`. A dry run with the same rules as the
 * daemon, so the count it gives is the count autoClean would remove (less any
 * that turn out to have uncommitted changes).
 */
export async function finishedWorktrees(config: Config, now?: () => number): Promise<SweepOutcome[]> {
  const outcomes = await sweepWorktrees(config, {
    dryRun: true,
    minIdleMs: config.settings.autoCleanAfterDays * DAY_MS,
    now,
  });
  return outcomes.filter((o) => o.kind === "removed");
}

export interface AutoCleanerOptions {
  loadConfig: () => Promise<Config>;
  /** How often to sweep. */
  intervalMs?: number;
  /** How long after start to sweep first, so booting the daemon stays quick. */
  initialDelayMs?: number;
  now?: () => number;
}

/**
 * The daemon's periodic sweep.
 *
 * It reloads the config on every tick, so turning autoClean on or off, or
 * linking a new repo, takes effect without a restart; with autoClean off a
 * tick is a config read and nothing else. The sweep is a handful of local git
 * calls per worktree and never fetches, so it costs nothing on the network:
 * "merged" means merged into the origin/<base> the last session fetched.
 */
export class AutoCleaner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SweepOutcome[]> | null = null;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;

  constructor(private readonly options: AutoCleanerOptions) {
    this.intervalMs = options.intervalMs ?? AUTO_CLEAN_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? AUTO_CLEAN_INITIAL_DELAY_MS;
  }

  start(): void {
    if (this.timer) return;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Sweep once, now. Overlapping calls share the sweep in flight, since two
   * at once would race each other's `git worktree remove`.
   */
  runOnce(): Promise<SweepOutcome[]> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (this.timer) this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async sweep(): Promise<SweepOutcome[]> {
    let config: Config;
    try {
      config = await this.options.loadConfig();
    } catch (err) {
      log.warn(`auto-clean: could not read the config`, describeError(err).message);
      return [];
    }
    if (!config.settings.autoClean) return [];

    const days = config.settings.autoCleanAfterDays;
    try {
      const outcomes = await sweepWorktrees(config, { minIdleMs: days * DAY_MS, now: this.options.now });
      for (const o of outcomes) {
        if (o.kind === "removed") {
          log.info(
            `auto-clean: removed ${o.branch}` +
              (o.removedBranch ? " and its worktree" : "'s worktree, kept the branch") +
              ` (${o.path}; merged, idle over ${days} day${days === 1 ? "" : "s"})`,
          );
        } else if (o.kind === "dirty") {
          log.info(`auto-clean: kept ${o.branch} — merged, but it has uncommitted changes`);
        } else if (o.kind === "repo-error") {
          log.warn(`auto-clean: skipped ${o.repoPath} — ${o.message}`);
        }
      }
      return outcomes;
    } catch (err) {
      log.warn("auto-clean: sweep failed", describeError(err).message);
      return [];
    }
  }
}

/**
 * Sessions finish on the scale of days, so sweeping every few hours is
 * plenty; more often would only spend git calls finding nothing new.
 */
export const AUTO_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Late enough that the first sweep never competes with attaching to Slack. */
export const AUTO_CLEAN_INITIAL_DELAY_MS = 60 * 1000;
