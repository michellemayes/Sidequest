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

export function repoForChannelName(config: Config, name: string): RepoLink | undefined {
  const key = channelKey(name);
  if (key.length === 0) return undefined;
  return config.channels[key];
}
