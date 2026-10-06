import { run } from "../util/exec.js";

/**
 * A repo's identity across computers: its origin as host/owner/repo,
 * lowercased, with the scheme, user, port and `.git` dropped, so
 * git@github.com:Acme/App.git and https://github.com/acme/app are one repo.
 * Empty for a remote that is a path on disk, which names nothing elsewhere.
 */
export function normalizeRemote(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return "";
    }
    if (parsed.protocol === "file:" || !parsed.hostname) return "";
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like: [user@]host:path. A bare path has no colon before its first slash.
    const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!scp) return "";
    host = scp[1]!;
    path = scp[2]!;
  }
  const cleaned = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return cleaned ? `${host}/${cleaned}`.toLowerCase() : "";
}

/** The part of a normalized remote after its host: owner/repo. */
export function remotePath(remote: string): string {
  const slash = remote.indexOf("/");
  return slash < 0 ? "" : remote.slice(slash + 1);
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; remote: string }>();

/**
 * A checkout's origin (or its only remote), normalized. Empty when it has
 * none or git cannot read it. Remembered a while: sync asks for every linked
 * repo and every candidate checkout each time it runs, and remotes rarely move.
 */
export async function repoRemote(root: string): Promise<string> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.remote;
  let remote = "";
  try {
    const { stdout } = await run("git", ["remote", "-v"], { cwd: root, timeoutMs: 10_000 });
    const lines = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2);
    const pick = lines.find((parts) => parts[0] === "origin") ?? lines[0];
    remote = pick ? normalizeRemote(pick[1]!) : "";
  } catch {
    remote = "";
  }
  cache.set(root, { at: Date.now(), remote });
  return remote;
}

/** For tests. */
export function clearRemoteCache(): void {
  cache.clear();
}
