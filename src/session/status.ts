/**
 * Where each recent session has got to, as seen from outside it.
 *
 * Sidequest hands a session to an agent in a terminal and, until now, lost
 * sight of it there. The watcher looks back in on the recent ones every so
 * often — has it committed, is there a pull request, did that merge, did the
 * agent leave a reply for the thread — so the mark on the Slack message can
 * say, and a reply can be offered the moment it is written.
 *
 * All of it is read from git, the worktree and (for pull requests) `gh`; the
 * agent is never asked. Anything that cannot be read is simply not reported.
 */
import { stat } from "node:fs/promises";
import { run, CommandError } from "../util/exec.js";
import { log } from "../util/log.js";
import { resultMtime } from "./result.js";
import type { HistoryEntry } from "./history.js";

export type SessionState =
  /** Started, nothing to show for it yet. */
  | "working"
  /** Left a reply for the thread without committing anything: an investigation, an answer. */
  | "answered"
  /** Has commits on its branch. */
  | "committed"
  | "pr-open"
  | "pr-closed"
  | "merged"
  /** The worktree has been cleaned up. */
  | "gone";

export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export interface SessionStatus {
  state: SessionState;
  /** Commits on the branch that its base does not have. */
  commits: number;
  /** Uncommitted changes in the worktree. */
  dirty: boolean;
  pr: PullRequest | null;
  /** mtime of the agent's result.md; null when it has not written one. */
  resultMs: number | null;
  /** A result newer than the one last posted, settled long enough to be finished. */
  resultPending: boolean;
}

/** States a session does not come back from, so it is not looked at again. */
const FINAL: ReadonlySet<SessionState> = new Set(["merged", "gone"]);

export interface WatcherOptions {
  /** How often to look. */
  intervalMs?: number;
  /** Only sessions started this recently are followed. */
  maxAgeMs?: number;
  /** And at most this many of them, newest first. */
  maxSessions?: number;
  /** How long a pull request lookup is trusted before `gh` is asked again. */
  prTtlMs?: number;
  /** How long result.md must sit unchanged before it counts as written. */
  settleMs?: number;
  /** Whether to look for pull requests with `gh` at all. */
  pullRequests?: boolean;
  history: () => Promise<HistoryEntry[]>;
  /** Called with every status whenever any of them changes. */
  onChange?: (statuses: Map<string, SessionStatus>) => void;
  now?: () => number;
}

export class StatusWatcher {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly prCache = new Map<string, { at: number; pr: PullRequest | null }>();
  private readonly baseRefs = new Map<string, string | null>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  /** Set when `gh` turns out not to be installed, so it is not spawned again. */
  private ghMissing = false;

  constructor(private readonly options: WatcherOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    this.stopped = false;
    const loop = async (): Promise<void> => {
      await this.refresh();
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.options.intervalMs ?? 15_000);
      // Following sessions is a courtesy; it is never what keeps the daemon up.
      this.timer.unref();
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The latest status of every followed session, by branch. */
  snapshot(): Map<string, SessionStatus> {
    return new Map(this.statuses);
  }

  /**
   * Look at every followed session now. Concurrent calls share one pass, so
   * a session starting while the timer fires does not double the work.
   */
  refresh(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    let history: HistoryEntry[];
    try {
      history = await this.options.history();
    } catch (err) {
      log.debug(`status: could not read history: ${String(err)}`);
      return;
    }
    const cutoff = this.now - (this.options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000);
    const recent = history
      .filter((entry) => Date.parse(entry.createdAt) >= cutoff && entry.worktreePath)
      .slice(-(this.options.maxSessions ?? 40));

    let changed = false;
    const keep = new Set<string>();
    for (const entry of recent) {
      keep.add(entry.branch);
      const before = this.statuses.get(entry.branch);
      let next: SessionStatus;
      if (before && FINAL.has(before.state)) {
        // Nothing more will happen to it, bar a result posted from Slack.
        next = { ...before, resultPending: this.isPending(before.resultMs, entry) };
      } else {
        try {
          next = await this.inspect(entry, before);
        } catch (err) {
          log.debug(`status: could not inspect ${entry.branch}: ${String(err)}`);
          continue;
        }
      }
      if (!before || !sameStatus(before, next)) changed = true;
      this.statuses.set(entry.branch, next);
    }
    for (const branch of this.statuses.keys()) {
      if (!keep.has(branch)) {
        this.statuses.delete(branch);
        changed = true;
      }
    }
    if (changed) this.options.onChange?.(this.snapshot());
  }

  private isPending(resultMs: number | null, entry: HistoryEntry): boolean {
    if (resultMs === null) return false;
    if (this.now - resultMs < (this.options.settleMs ?? 3_000)) return false;
    return resultMs > (entry.resultPostedMs ?? 0);
  }

  private async inspect(entry: HistoryEntry, before: SessionStatus | undefined): Promise<SessionStatus> {
    const cwd = entry.worktreePath;
    if (!(await isDirectory(cwd))) {
      // Cleaned up. What was known about its pull request still stands.
      const pr = before?.pr ?? null;
      return {
        state: pr?.state === "MERGED" ? "merged" : "gone",
        commits: before?.commits ?? 0,
        dirty: false,
        pr,
        resultMs: before?.resultMs ?? null,
        resultPending: false,
      };
    }

    const [commits, dirty, resultMs] = await Promise.all([
      this.commitsAhead(entry),
      run("git", ["status", "--porcelain"], { cwd, timeoutMs: 10_000 }).then(
        (r) => r.stdout.trim().length > 0,
        () => false,
      ),
      resultMtime(cwd),
    ]);
    // A branch with nothing on it has no pull request worth asking about.
    const pr = commits > 0 || before?.pr ? await this.pullRequest(entry) : null;

    let state: SessionState = "working";
    if (pr?.state === "MERGED") state = "merged";
    else if (pr?.state === "OPEN") state = "pr-open";
    else if (pr?.state === "CLOSED") state = "pr-closed";
    else if (commits > 0) state = "committed";
    else if (resultMs !== null) state = "answered";

    return { state, commits, dirty, pr, resultMs, resultPending: this.isPending(resultMs, entry) };
  }

  private async commitsAhead(entry: HistoryEntry): Promise<number> {
    const base = await this.baseRef(entry);
    if (!base) return 0;
    try {
      const { stdout } = await run("git", ["rev-list", "--count", `${base}..HEAD`], {
        cwd: entry.worktreePath,
        timeoutMs: 10_000,
      });
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /** The ref the branch was cut from, remembered per repo and base. */
  private async baseRef(entry: HistoryEntry): Promise<string | null> {
    const base = entry.baseBranch?.trim() ?? "";
    const key = `${entry.repoPath}\0${base}`;
    if (this.baseRefs.has(key)) return this.baseRefs.get(key)!;
    // Older entries did not record their base; the usual names cover most.
    const candidates = base
      ? [`origin/${base}`, base]
      : ["origin/HEAD", "origin/main", "main", "origin/master", "master"];
    let found: string | null = null;
    for (const ref of candidates) {
      try {
        await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
          cwd: entry.repoPath,
          timeoutMs: 10_000,
        });
        found = ref;
        break;
      } catch {
        // Try the next.
      }
    }
    this.baseRefs.set(key, found);
    return found;
  }

  private async pullRequest(entry: HistoryEntry): Promise<PullRequest | null> {
    const cached = this.prCache.get(entry.branch);
    if (cached && this.now - cached.at < (this.options.prTtlMs ?? 90_000)) return cached.pr;
    if (this.options.pullRequests === false || this.ghMissing) return cached?.pr ?? null;

    let pr: PullRequest | null = null;
    try {
      const { stdout } = await run("gh", ["pr", "view", entry.branch, "--json", "number,url,state"], {
        cwd: entry.worktreePath,
        timeoutMs: 15_000,
      });
      pr = parsePullRequest(stdout);
    } catch (err) {
      if (err instanceof CommandError && err.code === null && /not installed/.test(err.stderr)) {
        this.ghMissing = true;
        log.info("status: gh is not installed, so sessions' pull requests are not followed");
      }
      // Otherwise there is no pull request for the branch yet, or gh is not
      // signed in; either way there is nothing to show. Keep what was known.
      pr = cached?.pr ?? null;
    }
    this.prCache.set(entry.branch, { at: this.now, pr });
    return pr;
  }
}

export function parsePullRequest(json: string): PullRequest | null {
  try {
    const value = JSON.parse(json) as Partial<PullRequest>;
    if (typeof value.number !== "number" || typeof value.url !== "string") return null;
    const state = value.state === "MERGED" || value.state === "CLOSED" ? value.state : "OPEN";
    return { number: value.number, url: value.url, state };
  } catch {
    return null;
  }
}

function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  return a.state === b.state &&
    a.commits === b.commits &&
    a.dirty === b.dirty &&
    a.resultMs === b.resultMs &&
    a.resultPending === b.resultPending &&
    a.pr?.url === b.pr?.url &&
    a.pr?.state === b.pr?.state;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
