import { allPrompts } from "./store.js";
import { channelKey } from "./channels.js";
import type { Config } from "./schema.js";

/**
 * The slice of config the injected overlay is allowed to see.
 *
 * Deliberately not the whole config: repo paths, the base branch and the
 * Claude command are the daemon's business, and the page has no use for them.
 * What it needs is which channels are linked (to draw the header button) and
 * what the prompts are called (to label the menu).
 */
export interface PageConfig {
  prompts: Array<{ key: string; label: string; emoji: string }>;
  /** Channel keys that have a repo, so the overlay can show its state offline. */
  linkedChannels: string[];
  /** Repo label per channel key, for the header button's wording. */
  repoLabels: Record<string, string>;
  verbose: boolean;
}

export function pageConfig(config: Config): PageConfig {
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
    verbose: config.settings.verbose,
  };
}

/** Last path segment, without pulling node:path into a browser-shaped module. */
function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
