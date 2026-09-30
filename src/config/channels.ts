import type { Config, RepoLink } from "./schema.js";

/**
 * Channel identity comes from the DOM now, not the Slack API, so a link is
 * keyed by channel name rather than by id. Names are matched case-insensitively
 * and without the leading #, so "#Eng-Alerts" and "eng-alerts" are the same
 * channel.
 */
export function channelKey(name: string): string {
  return name.trim().replace(/^#+/, "").toLowerCase();
}

/** Every repo linked to a channel, the default first. */
export function linksForChannel(config: Config, name: string): RepoLink[] {
  const key = channelKey(name);
  if (key.length === 0) return [];
  return config.channels[key] ?? [];
}

/**
 * The repo a session in this channel runs in: the one named by `repo` (its
 * label or its path), or the channel's default when none is named.
 */
export function repoForChannelName(
  config: Config,
  name: string,
  repo = "",
): RepoLink | undefined {
  const links = linksForChannel(config, name);
  const wanted = repo.trim();
  if (!wanted) return links[0];
  return links.find((link) => linkMatches(link, wanted));
}

/** Every link in the config, across channels. */
export function allLinks(config: Config): RepoLink[] {
  return Object.values(config.channels).flat();
}

/** Each linked repo path once, in the order first linked. */
export function linkedRepoPaths(config: Config): string[] {
  return [...new Set(allLinks(config).map((link) => link.repoPath))];
}

/** Human-readable name for a link, without touching the filesystem. */
export function linkLabel(link: RepoLink): string {
  return link.label.trim() || basename(link.repoPath);
}

/** Whether `repo` names this link, by label or by path. */
export function linkMatches(link: RepoLink, repo: string): boolean {
  return linkLabel(link) === repo || link.repoPath === repo;
}

/**
 * Add a repo to a channel, or update it in place if it is already there.
 * A new repo goes after the ones already linked, so the default stays put.
 * The overlay tells a channel's repos apart by label, so a second checkout
 * with the same directory name is labelled with its parent directory too.
 */
export function addLink(config: Config, name: string, link: RepoLink): RepoLink {
  const key = channelKey(name);
  const links = config.channels[key] ?? [];
  const existing = links.findIndex((l) => l.repoPath === link.repoPath);
  const others = links.filter((_, i) => i !== existing);
  const stored = { ...link, channel: key };
  if (!stored.label.trim() && others.some((l) => linkLabel(l) === linkLabel(stored))) {
    stored.label = parentAndName(stored.repoPath);
  }
  if (existing >= 0) links[existing] = stored;
  else links.push(stored);
  config.channels[key] = links;
  return stored;
}

/**
 * Remove one repo from a channel, named by label or path, or every repo when
 * none is named. Returns what was removed.
 */
export function removeLink(config: Config, name: string, repo = ""): RepoLink[] {
  const key = channelKey(name);
  const links = config.channels[key] ?? [];
  const wanted = repo.trim();
  const removed = wanted ? links.filter((l) => linkMatches(l, wanted)).slice(0, 1) : links;
  const kept = links.filter((l) => !removed.includes(l));
  if (kept.length > 0) config.channels[key] = kept;
  else delete config.channels[key];
  return removed;
}

/** Last path segment, without pulling node:path into a browser-shaped module. */
function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function parentAndName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}
