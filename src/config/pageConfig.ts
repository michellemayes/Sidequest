import { allPrompts } from "./store.js";
import { linkLabel } from "./channels.js";
import { resolveAgent } from "../agents/agents.js";
import type { Config } from "./schema.js";
import { computeStats, type HistoryEntry } from "../session/history.js";

/** How many past sessions the page is told about, newest kept. */
const PAGE_HISTORY = 300;

export interface PageSession {
  key: string;
  label: string;
  branch: string;
  at: string;
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
  /** Where sessions open, e.g. "Warp" or "the Claude app". */
  agentHost: string;
  /** True when sessions open in a desktop app, with the prompt waiting to be sent. */
  agentInApp: boolean;
  /** Message ts -> sessions started from it, oldest first. */
  sessions: Record<string, PageSession[]>;
  stats: { total: number; today: number; streak: number };
  verbose: boolean;
}

export function pageConfig(config: Config, history: HistoryEntry[] = []): PageConfig {
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
    agentHost: agent.host,
    agentInApp: Boolean(agent.app),
    sessions: sessionsByMessage(history),
    stats: (({ total, today, streak }) => ({ total, today, streak }))(computeStats(history)),
    verbose: config.settings.verbose,
  };
}

function sessionsByMessage(history: HistoryEntry[]): Record<string, PageSession[]> {
  const out: Record<string, PageSession[]> = {};
  for (const entry of history.slice(-PAGE_HISTORY)) {
    if (!entry.ts) continue;
    (out[entry.ts] ??= []).push({
      key: entry.promptKey,
      label: entry.promptLabel,
      branch: entry.branch,
      at: entry.createdAt,
    });
  }
  return out;
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
