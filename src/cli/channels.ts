import { addLink, channelKey, linkLabel, linksForChannel, removeLink } from "../config/channels.js";
import { expandPath, updateConfig } from "../config/store.js";
import { inspectRepo } from "../git/repo.js";

export async function link(
  path: string,
  options: { channel: string; base?: string; label?: string },
): Promise<void> {
  const repo = await inspectRepo(expandPath(path));
  const key = channelKey(options.channel);
  const links = await updateConfig((config) => {
    addLink(config, key, {
      repoPath: repo.root,
      channel: key,
      baseBranch: options.base ?? "",
      label: options.label ?? "",
      linkedBy: "cli",
      linkedAt: new Date().toISOString(),
      remote: "",
    });
    return linksForChannel(config, key);
  });
  console.log(`Linked #${key} → ${repo.root}`);
  console.log(`Base branch: ${options.base || repo.defaultBranch}${options.base ? "" : " (detected)"}`);
  if (links.length > 1) {
    console.log(`#${key} now has ${links.length} repos: ${links.map(linkLabel).join(", ")} (default: ${linkLabel(links[0]!)})`);
  }
}

export async function unlink(channel: string, repo?: string): Promise<void> {
  const key = channelKey(channel);
  // A path is matched as linked, which is absolute; a label as written.
  const which = repo && /^[~./]/.test(repo.trim()) ? expandPath(repo) : (repo ?? "").trim();
  const { removed, left } = await updateConfig((config) => {
    const removed = removeLink(config, key, which);
    return { removed, left: linksForChannel(config, key) };
  });
  if (removed.length === 0) {
    console.log(which ? `${repo} is not linked to #${key}.` : `#${key} was not linked.`);
    return;
  }
  if (!which || left.length === 0) {
    console.log(`Unlinked #${key}.`);
    return;
  }
  console.log(`Unlinked ${linkLabel(removed[0]!)} from #${key}; it still has ${left.map(linkLabel).join(", ")}.`);
}
