/**
 * Finding the repo a channel is about, so linking one is a click rather than
 * a path typed from memory.
 *
 * Checkouts live in a handful of conventional places — ~/code, ~/src,
 * ~/Developer and so on, sometimes one level further down under an org — and
 * next to the repos already linked. Those are scanned two levels deep for a
 * `.git`, and what turns up is ranked against the channel's name: #storefront
 * and #storefront-eng both want `storefront` at the top.
 *
 * Only directory listings and one stat per candidate: nothing here runs git,
 * so it stays fast enough to answer while a menu is opening. The daemon still
 * validates whichever one is picked.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface RepoCandidate {
  name: string;
  path: string;
  /** The path with the home directory shortened to ~, for display. */
  display: string;
  /** Higher is a better match for the channel; 0 means no name match at all. */
  score: number;
  /** Already linked to some channel. */
  linked: boolean;
}

const DEFAULT_ROOTS = [
  "code", "Code", "src", "dev", "Dev", "Developer", "projects", "Projects",
  "repos", "Repos", "git", "GitHub", "github", "workspace", "work", "Work",
  "Sites", join("Documents", "GitHub"), join("Documents", "code"),
];

const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "Library", "Applications"]);
const MAX_DIRS = 4000;
const CACHE_MS = 60_000;

/** Words that say what a channel is for, not which codebase it is about. */
const GENERIC = new Set([
  "eng", "engineering", "team", "dev", "devs", "alerts", "alert", "bugs", "bug", "help",
  "support", "general", "ops", "internal", "feedback", "oncall", "on", "call",
  "notifications", "prs", "pr", "ci", "cd", "deploys", "deploy", "release", "releases",
  "discuss", "chat", "the", "and", "of", "x", "ext", "shared", "private", "announce",
]);

export function defaultSearchRoots(home: string = homedir()): string[] {
  return DEFAULT_ROOTS.map((r) => join(home, r));
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

const compact = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How well a repo's name matches a channel's. Pure, so it is tested alone. */
export function scoreRepoForChannel(repoName: string, channel: string): number {
  const channelTokens = tokens(channel);
  const topical = channelTokens.filter((t) => !GENERIC.has(t));
  const repoTokens = tokens(repoName);
  const repo = compact(repoName);
  if (!repo || channelTokens.length === 0) return 0;

  if (repo === compact(channel)) return 100;
  if (topical.length > 0 && repo === topical.join("")) return 95;

  let score = 0;
  const channelCompact = compact(channel);
  if (repo.length >= 3 && channelCompact.includes(repo)) score = Math.max(score, 70);
  for (const t of topical) {
    if (t.length >= 3 && repo.includes(t)) score = Math.max(score, 40 + Math.min(t.length, 10));
  }
  const shared = repoTokens.filter((t) => topical.includes(t)).length;
  score += shared * 10;
  return score;
}

interface Found {
  path: string;
  mtime: number;
}

let cache: { key: string; at: number; found: Found[] } | null = null;

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every checkout under the roots, two levels deep. */
async function scan(roots: string[], exclude: string[]): Promise<Found[]> {
  const found = new Map<string, Found>();
  let budget = MAX_DIRS;

  const consider = async (dir: string, depth: number): Promise<void> => {
    if (budget <= 0) return;
    budget -= 1;
    if (exclude.some((x) => dir === x || dir.startsWith(`${x}/`))) return;
    const git = join(dir, ".git");
    if (existsSync(git)) {
      try {
        const info = await stat(git);
        // A `.git` file is a worktree or submodule, not a checkout of its own.
        if (info.isDirectory()) found.set(dir, { path: dir, mtime: info.mtimeMs });
      } catch {
        // Vanished between the two calls; skip it.
      }
      return;
    }
    if (depth === 0) return;
    let children: string[];
    try {
      children = (await readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
        .map((d) => join(dir, d.name));
    } catch {
      return;
    }
    await Promise.all(children.map((child) => consider(child, depth - 1)));
  };

  await Promise.all(
    roots.map(async (root) => {
      if (await isDir(root)) await consider(root, 2);
    }),
  );
  return [...found.values()];
}

export interface DiscoverOptions {
  channel: string;
  /** Repos already linked to some channel; their parents are searched too. */
  linkedRepos: string[];
  /** Where Sidequest keeps its own worktrees, which are never suggestions. */
  worktreesRoot: string;
  roots?: string[];
  limit?: number;
}

export async function discoverRepos(options: DiscoverOptions): Promise<RepoCandidate[]> {
  const roots = [
    ...(options.roots ?? defaultSearchRoots()),
    ...options.linkedRepos.map((p) => dirname(p)),
  ];
  const uniqueRoots = [...new Set(roots)];
  const key = `${uniqueRoots.join("\0")}|${options.worktreesRoot}`;

  let found: Found[];
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    found = cache.found;
  } else {
    found = await scan(uniqueRoots, [options.worktreesRoot]);
    for (const repo of options.linkedRepos) {
      if (!found.some((f) => f.path === repo) && (await isDir(repo))) {
        found.push({ path: repo, mtime: 0 });
      }
    }
    cache = { key, at: Date.now(), found };
  }

  const linked = new Set(options.linkedRepos);
  const home = homedir();
  const shorten = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const newest = Math.max(1, ...found.map((f) => f.mtime));
  const ranked = found.map((f) => {
    const name = basename(f.path);
    const score = scoreRepoForChannel(name, options.channel);
    // Recency only breaks ties between equally good (or equally absent) name
    // matches; it never lifts an unrelated repo over a named one.
    const recency = f.mtime > 0 ? f.mtime / newest : 0;
    return { name, path: f.path, score, linked: linked.has(f.path), sort: score + (linked.has(f.path) ? 2 : 0) + recency };
  });
  ranked.sort((a, b) => b.sort - a.sort || a.name.localeCompare(b.name));
  return ranked
    .slice(0, options.limit ?? 40)
    .map(({ name, path, score, linked: isLinked }) => ({
      name,
      path,
      display: shorten(path),
      score,
      linked: isLinked,
    }));
}

/** For tests: forget what the last scan found. */
export function clearDiscoveryCache(): void {
  cache = null;
}
