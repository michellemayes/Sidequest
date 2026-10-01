/**
 * A record of every session Sidequest has started.
 *
 * Two things read it. The overlay marks the messages that already have a
 * session, so a second click reopens the first instead of cutting a -2 branch
 * nobody wanted; and the stats — how many, how many today, how many days in a
 * row — are what the launch toast and `sidequest stats` report.
 *
 * It lives next to the config under the config root, so SIDEQUEST_HOME keeps
 * the tests isolated, and it is capped: this is a log of recent work, not an
 * archive.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { historyFile } from "../config/paths.js";

export const HISTORY_LIMIT = 1000;

/** Totals worth a small celebration when a session lands exactly on one. */
export const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000] as const;

export interface HistoryEntry {
  /** Slack's message ts, which is how the overlay finds the message again. */
  ts: string;
  channel: string;
  promptKey: string;
  promptLabel: string;
  branch: string;
  worktreePath: string;
  repoPath: string;
  repoLabel: string;
  createdAt: string;
  /** The message's permalink, which is where its result gets posted. Missing on older entries. */
  permalink?: string;
  /** What the branch was cut from, for counting its commits. Missing on older entries. */
  baseBranch?: string;
  /** The agent the session was handed to, e.g. "Claude Code", which its reply is signed with. Missing on older entries. */
  agentLabel?: string;
  /**
   * The mtime of the result.md last posted to the thread, so the same result
   * is never offered twice and a rewritten one is offered again.
   */
  resultPostedMs?: number;
}

export interface Stats {
  total: number;
  today: number;
  /** Consecutive days with a session, ending today — or yesterday, so a
      streak is not lost just because today's first session has not happened. */
  streak: number;
  bestStreak: number;
  /** True when today's session was the first of the day. */
  firstToday: boolean;
  /** Set when `total` is exactly one of MILESTONES. */
  milestone: number | null;
  byPrompt: Record<string, number>;
  byChannel: Record<string, number>;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyFile(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { sessions?: unknown })?.sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : [];
    return list.filter(isEntry);
  } catch {
    // A corrupt history is not worth refusing to start a session over.
    return [];
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.branch === "string" && typeof v.createdAt === "string";
}

/**
 * Serialised in-process, so two sessions started a moment apart cannot each
 * read the file, append, and have the second write drop the first.
 */
let writing: Promise<unknown> = Promise.resolve();

export function recordSession(entry: HistoryEntry): Promise<HistoryEntry[]> {
  return rewrite((history) => {
    history.push(entry);
    return history.slice(-HISTORY_LIMIT);
  });
}

/**
 * Change the entry for one branch in place, e.g. to note that its result was
 * posted. Resolves to the history as written; a branch it does not know
 * leaves the file as it was.
 */
export function updateSession(branch: string, patch: Partial<HistoryEntry>): Promise<HistoryEntry[]> {
  return rewrite((history) => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]!.branch !== branch) continue;
      history[i] = { ...history[i]!, ...patch, branch };
      break;
    }
    return history;
  });
}

function rewrite(change: (history: HistoryEntry[]) => HistoryEntry[]): Promise<HistoryEntry[]> {
  const next = writing.then(async () => {
    const kept = change(await loadHistory());
    const file = historyFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, sessions: kept }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmp, file);
    return kept;
  });
  writing = next.catch(() => undefined);
  return next;
}

/** Local calendar day, so a streak follows the reader's midnight, not UTC's. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function previousDay(date: Date): Date {
  const prev = new Date(date);
  prev.setDate(prev.getDate() - 1);
  return prev;
}

export function computeStats(history: HistoryEntry[], now: Date = new Date()): Stats {
  const days = new Set<string>();
  const perDay = new Map<string, number>();
  const byPrompt: Record<string, number> = {};
  const byChannel: Record<string, number> = {};

  for (const entry of history) {
    const at = new Date(entry.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = dayKey(at);
    days.add(key);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    if (entry.promptKey) byPrompt[entry.promptKey] = (byPrompt[entry.promptKey] ?? 0) + 1;
    if (entry.channel) byChannel[entry.channel] = (byChannel[entry.channel] ?? 0) + 1;
  }

  const todayKey = dayKey(now);
  const today = perDay.get(todayKey) ?? 0;

  let streak = 0;
  let cursor = days.has(todayKey) ? now : previousDay(now);
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor = previousDay(cursor);
  }

  let bestStreak = 0;
  let run = 0;
  let last: string | null = null;
  for (const key of [...days].sort()) {
    run = last !== null && dayKey(nextDay(last)) === key ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    last = key;
  }

  const total = history.length;
  return {
    total,
    today,
    streak,
    bestStreak,
    firstToday: today === 1,
    milestone: (MILESTONES as readonly number[]).includes(total) ? total : null,
    byPrompt,
    byChannel,
  };
}

function nextDay(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(y!, m! - 1, d! + 1);
}

/** The most recent session, for `sidequest reopen` with nothing named. */
export function latestSession(history: HistoryEntry[]): HistoryEntry | undefined {
  return history[history.length - 1];
}
