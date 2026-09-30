import { allPrompts } from "./store.js";
import { channelKey } from "./channels.js";
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
 * What it needs is which channels are linked (to draw the header button),
 * what the prompts are called (to label the menu), and which agent is active
 * (to word its tooltips). Past sessions are keyed by Slack's message ts
 * with the branch they made and nothing else, so a message that already has
 * one can offer to reopen it.
 */
export interface PageConfig {
  prompts: Array<{ key: string; label: string; emoji: string }>;
  /** Channel keys that have a repo, so the overlay can show its state offline. */
  linkedChannels: string[];
  /** Repo label per channel key, for the header button's wording. */
  repoLabels: Record<string, string>;
  /** Human label of the agent sessions launch, e.g. "Claude Code". */
  agentLabel: string;
  /** Message ts -> sessions started from it, oldest first. */
  sessions: Record<string, PageSession[]>;
  stats: { total: number; today: number; streak: number };
  verbose: boolean;
}

export function pageConfig(config: Config, history: HistoryEntry[] = []): PageConfig {
  const repoLabels: Record<string, string> = {};
  for (const [key, link] of Object.entries(config.channels)) {
    repoLabels[key] = link.label.trim() || basename(link.repoPath);
  }

  return {
    prompts: allPrompts(config).map(({ key, prompt }) => ({
      key,
      label: prompt.label,
      emoji: prompt.emoji,
    })),
    linkedChannels: Object.keys(config.channels).map(channelKey),
    repoLabels,
    agentLabel: resolveAgent(config.settings.agent).label,
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

/** Last path segment, without pulling node:path into a browser-shaped module. */
function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
