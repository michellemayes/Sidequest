import { allPrompts } from "./store.js";
import { linkLabel } from "./channels.js";
import { resolveAgent } from "../agents/agents.js";
import { sessionHost } from "../terminals/registry.js";
import type { Config } from "./schema.js";
import { computeStats, type HistoryEntry } from "../session/history.js";
import type { SessionState, SessionStatus } from "../session/status.js";

/** How many past sessions the page is told about, newest kept. */
const PAGE_HISTORY = 300;

export interface PageSession {
  key: string;
  label: string;
  branch: string;
  at: string;
  /** Where the session has got to, when the daemon is following it. */
  status?: PageStatus;
  /**
   * Found after the session was reported started: the terminal opened but
   * the agent did not start in it. The overlay adds it to the message's line.
   */
  launchError?: string;
}

/** A session's progress, as much of it as the mark on its message shows. */
export interface PageStatus {
  /** The progress fields are left out when settings.trackStatus is off. */
  state?: SessionState;
  commits?: number;
  dirty?: boolean;
  pr?: { number: number; url: string } | null;
  /** The agent left a reply for the thread that has not been posted yet. */
  reply: boolean;
  /** When that reply was last written, so a rewrite is news again. */
  replyAt?: number;
}

/**
 * The slice of config the injected overlay is allowed to see.
 *
 * Deliberately not the whole config: repo paths, the base branch and the
 * agent command are the daemon's business, and the page has no use for them.
 * (Paths reach the page only as link suggestions, and only when it asks.)
 * What it needs is which channels are linked and to which repos, by label
 * (to draw the header button and let a message pick among them),
 * what the prompts are called (to label the menu), and which agent is active
 * (to word its tooltips). Past sessions are keyed by Slack's message ts
 * with the branch they made and nothing else, so a message that already has
 * one can offer to reopen it.
 */
export interface PageConfig {
  prompts: Array<{ key: string; label: string; emoji: string }>;
  /** Channel keys that have a repo, so the overlay can show its state offline. */
  linkedChannels: string[];
  /** Repo labels per channel key, the default first. A label is how the page names a repo. */
  repoLabels: Record<string, string[]>;
  /** Per channel key, the label of the repo its latest session ran in, if still linked. */
  lastRepos: Record<string, string>;
  /** Human label of the agent sessions launch, e.g. "Claude Code". */
  agentLabel: string;
  /**
   * Where sessions open, e.g. "Warp", "iTerm2", "the background" or "the
   * Claude app"; the overlay names it in toasts and tooltips.
   */
  agentHost: string;
  /** True when sessions open in a desktop app, with the prompt waiting to be sent. */
  agentInApp: boolean;
  /** True when sessions run with no terminal, so there is no window to reopen. */
  headless: boolean;
  /** Message ts -> sessions started from it, oldest first. */
  sessions: Record<string, PageSession[]>;
  stats: { total: number; today: number; streak: number };
  /** What to do with a reply an agent leaves: offer it, post it, or neither. */
  postResults: string;
  verbose: boolean;
}

export function pageConfig(
  config: Config,
  history: HistoryEntry[] = [],
  statuses: Map<string, SessionStatus> = new Map(),
  launchErrors: Map<string, string> = new Map(),
): PageConfig {
  const repoLabels: Record<string, string[]> = {};
  for (const [key, links] of Object.entries(config.channels)) {
    if (links.length > 0) repoLabels[key] = links.map(linkLabel);
  }

  const agent = resolveAgent(config.settings.agent);
  return {
    prompts: allPrompts(config).map(({ key, prompt }) => ({
      key,
      label: prompt.label,
      emoji: prompt.emoji,
    })),
    linkedChannels: Object.keys(repoLabels),
    repoLabels,
    lastRepos: lastRepos(config, history),
    agentLabel: agent.label,
    agentHost: sessionHost(agent, config.settings.terminal),
    agentInApp: Boolean(agent.app),
    headless: !agent.app && config.settings.terminal === "headless",
    sessions: sessionsByMessage(history, statuses, config.settings.trackStatus, launchErrors),
    stats: (({ total, today, streak }) => ({ total, today, streak }))(computeStats(history)),
    postResults: config.settings.postResults,
    verbose: config.settings.verbose,
  };
}

function sessionsByMessage(
  history: HistoryEntry[],
  statuses: Map<string, SessionStatus>,
  progress: boolean,
  launchErrors: Map<string, string>,
): Record<string, PageSession[]> {
  const out: Record<string, PageSession[]> = {};
  for (const entry of history.slice(-PAGE_HISTORY)) {
    if (!entry.ts) continue;
    const status = statuses.get(entry.branch);
    const launchError = launchErrors.get(entry.branch);
    (out[entry.ts] ??= []).push({
      key: entry.promptKey,
      label: entry.promptLabel,
      branch: entry.branch,
      at: entry.createdAt,
      ...(status ? { status: progress ? pageStatus(status) : replyStatus(status) } : {}),
      ...(launchError ? { launchError } : {}),
    });
  }
  return out;
}

/** Paths and timestamps are the daemon's; the page gets what it draws. */
function pageStatus(status: SessionStatus): PageStatus {
  return {
    state: status.state,
    commits: status.commits,
    dirty: status.dirty,
    pr: status.pr ? { number: status.pr.number, url: status.pr.url } : null,
    ...replyStatus(status),
  };
}

function replyStatus(status: SessionStatus): Pick<PageStatus, "reply" | "replyAt"> {
  return status.resultPending && status.resultMs !== null
    ? { reply: true, replyAt: status.resultMs }
    : { reply: false };
}

/**
 * Where each channel's latest session ran, so a channel with several repos
 * opens its menu on the one in use rather than always on the first.
 */
function lastRepos(config: Config, history: HistoryEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of history) {
    const link = config.channels[entry.channel]?.find((l) => l.repoPath === entry.repoPath);
    if (link) out[entry.channel] = linkLabel(link);
  }
  return out;
}
