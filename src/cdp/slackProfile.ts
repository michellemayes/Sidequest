/**
 * Slack 4.53 and later refuse --remote-debugging-port on their default
 * profile and exit straight away ("--remote-debugging-port is not allowed
 * against the default profile"). Sidequest launches Slack on a profile of its
 * own instead, seeded from the default one so your workspaces come with it.
 */
import { existsSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PROFILE_NAME = "Slack-Sidequest";

/** Caches and locks: rebuilt by Slack, and a copied lock would stop it starting. */
const SKIPPED = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "CacheStorage",
  "ScriptCache",
  "Crashpad",
  "logs",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "RunningChromeVersion",
]);

/**
 * Slack's default profile: the direct download's, or the App Store build's
 * inside its sandbox container. The App Store build can only write inside
 * its container, so Sidequest's profile sits next to whichever is found.
 */
export function defaultSlackProfile(home = homedir()): string | null {
  const candidates = [
    join(home, "Library", "Application Support", "Slack"),
    join(home, "Library", "Containers", "com.tinyspeck.slackmacgap", "Data", "Library", "Application Support", "Slack"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

export function sidequestSlackProfile(home = homedir()): string {
  const base = defaultSlackProfile(home);
  return base ? join(dirname(base), PROFILE_NAME) : join(home, "Library", "Application Support", PROFILE_NAME);
}

/**
 * Create Sidequest's profile from the default one, once, so you stay signed
 * in. Slack must be quit: its files are copied as they lie. Built under a
 * temporary name and renamed, so a copy cut short is never used.
 */
export async function ensureSidequestProfile(home = homedir()): Promise<string> {
  const target = sidequestSlackProfile(home);
  if (existsSync(target)) return target;
  const source = defaultSlackProfile(home);
  if (!source) return target;
  const partial = `${target}.partial`;
  await rm(partial, { recursive: true, force: true });
  await cp(source, partial, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !SKIPPED.has(basename(path)),
  });
  await rename(partial, target);
  return target;
}
