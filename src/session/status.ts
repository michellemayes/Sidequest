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
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many sessions are looked at side by side; each is a few git processes. */
const INSPECT_CONCURRENCY = 4;
/**
 * A branch with no pull request is asked about this often once it is a day
 * old: by then most that are going to get one have, and asking every 90s
 * for each of forty old sessions is most of what the watcher spends.
 */
const OLD_NO_PR_RECHECK_MS = 10 * 60 * 1000;
/**
 * A session nothing has visibly touched for a day is looked at in full this
 * often, rather than on every tick. The quick check (see activityMs) sees
 * commits, checkouts and files added or removed at the top of the worktree,
 * not an edit deep inside it, which this catches within ten minutes.
 */
const IDLE_RECHECK_MS = 10 * 60 * 1000;
/** Pull requests listed per repo per pass; a session's is among the recent ones. */
const PR_LIST_LIMIT = 100;

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
  /** Per repo, this pass's one `gh pr list`, shared by every session in it. */
  private prLists = new Map<string, Promise<Map<string, PullRequest> | null>>();
  /** When each session was last looked at in full, and how active it looked then. */
  private readonly lastFull = new Map<string, { at: number; activityMs: number | null }>();
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

    // A fresh list per pass: within one, every session in a repo shares it.
    this.prLists = new Map();
    const inspected = await mapLimit(recent, INSPECT_CONCURRENCY, async (entry): Promise<SessionStatus | null> => {
      const before = this.statuses.get(entry.branch);
      if (before && FINAL.has(before.state)) {
        // Nothing more will happen to it, bar a result posted from Slack.
        return { ...before, resultPending: this.isPending(before.resultMs, entry) };
      }
      try {
        return await this.inspect(entry, before);
      } catch (err) {
        log.debug(`status: could not inspect ${entry.branch}: ${String(err)}`);
        return null;
      }
    });

    let changed = false;
    const keep = new Set<string>();
    recent.forEach((entry, index) => {
      keep.add(entry.branch);
      const next = inspected[index];
      if (!next) return;
      const before = this.statuses.get(entry.branch);
      if (!before || !sameStatus(before, next)) changed = true;
      this.statuses.set(entry.branch, next);
    });
    for (const branch of this.statuses.keys()) {
      if (!keep.has(branch)) {
        this.statuses.delete(branch);
        this.lastFull.delete(branch);
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

    // An idle session is looked at in full only now and then; in between,
    // what it had stands, and only its reply and pull request are checked.
    const activityMs = await this.activityMs(cwd);
    const last = this.lastFull.get(entry.branch);
    if (
      before &&
      last &&
      activityMs !== null &&
      activityMs === last.activityMs &&
      this.now - activityMs > DAY_MS &&
      this.now - last.at < IDLE_RECHECK_MS
    ) {
      const resultMs = await resultMtime(cwd);
      const pr = before.commits > 0 || before.pr ? await this.pullRequest(entry) : null;
      return {
        state: stateOf(before.commits, pr, resultMs),
        commits: before.commits,
        dirty: before.dirty,
        pr,
        resultMs,
        resultPending: this.isPending(resultMs, entry),
      };
    }
    this.lastFull.set(entry.branch, { at: this.now, activityMs });

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

    return {
      state: stateOf(commits, pr, resultMs),
      commits,
      dirty,
      pr,
      resultMs,
      resultPending: this.isPending(resultMs, entry),
    };
  }

  /**
   * When anything visibly last happened in a worktree, from a few stats: the
   * worktree's directory (files added or removed at its top) and its git
   * dir's HEAD and HEAD log (commits, checkouts, resets). Not the index,
   * which `git status` itself rewrites. Null when none can be read.
   */
  private async activityMs(cwd: string): Promise<number | null> {
    const paths = [cwd];
    const gitDir = await worktreeGitDir(cwd);
    if (gitDir) paths.push(join(gitDir, "HEAD"), join(gitDir, "logs", "HEAD"));
    let latest: number | null = null;
    for (const path of paths) {
      try {
        const { mtimeMs } = await stat(path);
        latest = latest === null ? mtimeMs : Math.max(latest, mtimeMs);
      } catch {
        // Not there (no commits yet, say); the others still count.
      }
    }
    return latest;
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

  /**
   * Whether to ask about this branch's pull request again. One that has a
   * pull request is followed closely, since that is what moves (opened,
   * merged); one without is asked about as often for its first day, then
   * rarely.
   */
  private prDue(entry: HistoryEntry, cached: { at: number; pr: PullRequest | null } | undefined): boolean {
    if (!cached) return true;
    const ttl = this.options.prTtlMs ?? 90_000;
    const age = this.now - cached.at;
    if (cached.pr) return age >= ttl;
    const created = Date.parse(entry.createdAt);
    const young = !Number.isFinite(created) || this.now - created < DAY_MS;
    return age >= (young ? ttl : Math.max(ttl, OLD_NO_PR_RECHECK_MS));
  }

  private async pullRequest(entry: HistoryEntry): Promise<PullRequest | null> {
    const cached = this.prCache.get(entry.branch);
    if (!this.prDue(entry, cached)) return cached!.pr;
    if (this.options.pullRequests === false || this.ghMissing) return cached?.pr ?? null;

    const listed = await this.pullRequestList(entry.repoPath);
    let pr: PullRequest | null;
    if (listed === null) {
      // gh failed (not signed in, offline): keep what was known.
      pr = cached?.pr ?? null;
    } else if (listed.has(entry.branch)) {
      pr = listed.get(entry.branch)!;
    } else if (cached?.pr) {
      // It had one, which has since dropped out of the most recent few in a
      // busy repo; ask about it by name rather than lose it.
      pr = (await this.viewPullRequest(entry)) ?? cached.pr;
    } else {
      pr = null;
    }
    this.prCache.set(entry.branch, { at: this.now, pr });
    return pr;
  }

  /**
   * The repo's recent pull requests, by head branch, from one `gh pr list`
   * per repo per pass rather than a `gh pr view` per session. Null when gh
   * could not be asked.
   */
  private pullRequestList(repoPath: string): Promise<Map<string, PullRequest> | null> {
    let listed = this.prLists.get(repoPath);
    if (!listed) {
      listed = run(
        "gh",
        ["pr", "list", "--state", "all", "--json", "headRefName,number,state,url", "--limit", String(PR_LIST_LIMIT)],
        { cwd: repoPath, timeoutMs: 15_000 },
      ).then(
        ({ stdout }) => parsePullRequestList(stdout),
        (err: unknown) => {
          this.noteGhFailure(err);
          return null;
        },
      );
      this.prLists.set(repoPath, listed);
    }
    return listed;
  }

  private async viewPullRequest(entry: HistoryEntry): Promise<PullRequest | null> {
    try {
      const { stdout } = await run("gh", ["pr", "view", entry.branch, "--json", "number,url,state"], {
        cwd: entry.worktreePath,
        timeoutMs: 15_000,
      });
      return parsePullRequest(stdout);
    } catch (err) {
      this.noteGhFailure(err);
      return null;
    }
  }

  private noteGhFailure(err: unknown): void {
    if (err instanceof CommandError && err.code === null && /not installed/.test(err.stderr)) {
      if (!this.ghMissing) log.info("status: gh is not installed, so sessions' pull requests are not followed");
      this.ghMissing = true;
    }
    // Otherwise gh is not signed in, or offline; there is nothing to show.
  }
}

/**
 * `gh pr list --json headRefName,number,state,url`, by head branch. Newest
 * first as gh lists them; when a branch has had several, an open one wins,
 * then the newest.
 */
export function parsePullRequestList(json: string): Map<string, PullRequest> | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out = new Map<string, PullRequest>();
  for (const item of value as Array<Partial<PullRequest> & { headRefName?: unknown }>) {
    if (typeof item.headRefName !== "string" || typeof item.number !== "number" || typeof item.url !== "string") {
      continue;
    }
    const state = item.state === "MERGED" || item.state === "CLOSED" ? item.state : "OPEN";
    const existing = out.get(item.headRefName);
    if (existing && !(state === "OPEN" && existing.state !== "OPEN")) continue;
    out.set(item.headRefName, { number: item.number, url: item.url, state });
  }
  return out;
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

function stateOf(commits: number, pr: PullRequest | null, resultMs: number | null): SessionState {
  if (pr?.state === "MERGED") return "merged";
  if (pr?.state === "OPEN") return "pr-open";
  if (pr?.state === "CLOSED") return "pr-closed";
  if (commits > 0) return "committed";
  if (resultMs !== null) return "answered";
  return "working";
}

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A worktree's own git dir: `.git` there is a file naming it. A plain
 * checkout's `.git` is the directory itself.
 */
async function worktreeGitDir(cwd: string): Promise<string | null> {
  const dotGit = join(cwd, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return dotGit;
    const match = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const dir = match[1]!.trim();
    return isAbsolute(dir) ? dir : resolve(cwd, dir);
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
