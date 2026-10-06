/**
 * Settings sync: the same channel links, prompts and settings on every
 * computer signed in to your Slack.
 *
 * There is no server. The shared copy is one pinned message in your DM with
 * yourself, which the overlay reads and writes through Slack's API as you
 * (client/overlay/sync.js), the way it posts thread replies. Everything else
 * happens here, in the daemon:
 *
 * - What syncs is the portable part of the config. A link is synced as the
 *   repo's origin (github.com/acme/storefront) rather than its path, and each
 *   computer finds its own checkout of that repo among the ones discovery
 *   turns up. One it cannot find yet waits in sync.json and is placed once
 *   the repo is cloned. Paths, the terminal and other per-machine settings
 *   stay local.
 * - Changes merge three ways against the copy both sides last agreed on
 *   (sync.json's `base`), per channel, per prompt and per setting: whichever
 *   side changed a thing wins, so two computers changing different things
 *   both keep their change. When both changed the same thing, a channel gets
 *   the repos of both, and a prompt or setting takes what is already in Slack.
 */
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { allLinks, channelKey, linkedRepoPaths } from "./channels.js";
import { syncStateFile } from "./paths.js";
import { configSchema, settingsSchema, type Config, type RepoLink } from "./schema.js";
import { expandPath, updateConfig } from "./store.js";
import { discoverRepos } from "../git/discover.js";
import { remotePath, repoRemote } from "../git/remote.js";
import { UserFacingError } from "../util/errors.js";

/**
 * The settings that mean the same on any computer. The rest (worktreesRoot,
 * the terminal and how to open it, search roots, the DevTools port) describe
 * this machine, and the agent's command can be a path that only exists here.
 */
export const SYNCED_SETTINGS = [
  "agent",
  "fetchBeforeCreate",
  "threadContextLimit",
  "pruneBranchesOnClean",
  "autoClean",
  "autoCleanAfterDays",
  "autoReply",
  "reactions",
  "postResults",
  "trackStatus",
] as const;

const syncedLinkSchema = z.object({
  /** normalizeRemote's spelling of the origin; empty for a repo with none. */
  remote: z.string().default(""),
  /** The repo's name, which finds it when it has no remote. */
  name: z.string().min(1),
  label: z.string().default(""),
  baseBranch: z.string().default(""),
});
export type SyncedLink = z.infer<typeof syncedLinkSchema>;

const syncedSettingsSchema = settingsSchema
  .pick({
    fetchBeforeCreate: true,
    threadContextLimit: true,
    pruneBranchesOnClean: true,
    autoClean: true,
    autoCleanAfterDays: true,
    autoReply: true,
    reactions: true,
    postResults: true,
    trackStatus: true,
  })
  .extend({ agent: z.object({ id: z.string(), args: z.array(z.string()).default([]) }) })
  .partial();

export const syncContentSchema = z.object({
  channels: z.record(z.string(), z.array(syncedLinkSchema)).default({}),
  prompts: configSchema.shape.prompts,
  settings: syncedSettingsSchema.default({}),
});
export type SyncContent = z.infer<typeof syncContentSchema>;

const noteSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().default(""),
  /** Which computer wrote it, for the note's own line and the daemon's log. */
  from: z.string().default(""),
  content: syncContentSchema,
});
export type SyncNote = z.infer<typeof noteSchema>;

/** Finds the note among your pins; the overlay looks for the same string. */
export const NOTE_MARKER = "sidequest-sync:v1";
/** Slack keeps 40,000 characters of a message; leave room for the words around the data. */
const MAX_NOTE = 38_000;

/** This computer, as the note names it: "Michelles-MacBook-Pro", not ".local". */
export function machineName(): string {
  return hostname().replace(/\.local$/i, "") || "another computer";
}

/**
 * The message as posted. The settings go in base64, not as JSON: Slack turns
 * URLs into links and reads &, < and > as markup, and base64 has none of them.
 */
export function encodeNote(content: SyncContent, at = new Date(), from = machineName()): string {
  const note: SyncNote = { version: 1, updatedAt: at.toISOString(), from, content };
  const data = Buffer.from(JSON.stringify(note), "utf8").toString("base64");
  const text = [
    `:sparkles: *Sidequest settings*, shared by your computers (last changed on ${from.replace(/[&<>*_`~]/g, "")}).`,
    "Sidequest keeps this message up to date; leave it pinned. `sidequest sync off` stops it.",
    "```",
    NOTE_MARKER,
    data,
    "```",
  ].join("\n");
  if (text.length > MAX_NOTE) {
    throw new UserFacingError(
      "Your Sidequest settings are too big to keep in a Slack message.",
      "Shorten your custom prompts, or turn sync off with `sidequest sync off`.",
    );
  }
  return text;
}

/** The note a message holds. Throws if it is not one, or no longer reads. */
export function decodeNote(text: string): SyncNote {
  const at = text.indexOf(NOTE_MARKER);
  if (at < 0) throw new Error("not a Sidequest settings note");
  const data = text.slice(at + NOTE_MARKER.length).match(/^\s*([A-Za-z0-9+/=\s]+)/)?.[1]?.replace(/\s+/g, "");
  if (!data) throw new Error("the settings note has no data");
  return noteSchema.parse(JSON.parse(Buffer.from(data, "base64").toString("utf8")));
}

/** JSON with every object's keys sorted, so equal content compares equal. */
export function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

const own = <T>(record: Record<string, T> | null | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * Merge two changed copies of a record against the one both started from.
 * A key only one side changed takes that side's value (a deletion included);
 * one both changed, differently, goes to `conflict`. No base, as on a first
 * sync, makes every difference a conflict.
 */
export function merge3<T>(
  base: Record<string, T> | null,
  local: Record<string, T>,
  remote: Record<string, T>,
  conflict: (local: T | undefined, remote: T | undefined) => T | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const l = own(local, key);
    const r = own(remote, key);
    const b = own(base, key);
    const value = same(l, r) ? l : same(l, b) ? r : same(r, b) ? l : conflict(l, r);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Two synced links are one repo when they share an origin, or a name when neither has one. */
export function linkIdentity(link: SyncedLink): string {
  return link.remote || `name:${link.name.toLowerCase()}`;
}

/** Every repo of the first list, then the ones only the second has. */
function unionLinks(first: SyncedLink[], second: SyncedLink[]): SyncedLink[] {
  const out = [...first];
  for (const link of second) {
    if (!out.some((l) => linkIdentity(l) === linkIdentity(link))) out.push(link);
  }
  return out;
}

export function mergeContent(base: SyncContent | null, local: SyncContent, remote: SyncContent): SyncContent {
  return {
    channels: merge3(base?.channels ?? null, local.channels, remote.channels, (l, r) =>
      unionLinks(r ?? [], l ?? []),
    ),
    prompts: merge3(base?.prompts ?? null, local.prompts, remote.prompts, (l, r) => r ?? l),
    settings: merge3(
      (base?.settings ?? null) as Record<string, unknown> | null,
      local.settings as Record<string, unknown>,
      remote.settings as Record<string, unknown>,
      (l, r) => r ?? l,
    ) as SyncContent["settings"],
  };
}

/**
 * A link as another computer can use it. A repo with an origin is named for
 * it rather than for the folder it sits in here, so two computers that cloned
 * it into differently named folders still agree on what they have.
 */
export function portableLink(link: RepoLink): SyncedLink {
  const fromRemote = link.remote ? remotePath(link.remote).split("/").pop() : "";
  return {
    remote: link.remote,
    name: fromRemote || basename(link.repoPath.replace(/[/\\]+$/, "")) || link.repoPath,
    label: link.label,
    baseBranch: link.baseBranch,
  };
}

/** A synced link this computer has no checkout for yet, and where in its channel's list it goes. */
export interface PendingLink {
  index: number;
  link: SyncedLink;
}

/** This computer's side of the merge: the config, plus the links waiting for a checkout. */
export function localContent(config: Config, pending: Record<string, PendingLink[]>): SyncContent {
  const channels: Record<string, SyncedLink[]> = {};
  for (const key of new Set([...Object.keys(config.channels), ...Object.keys(pending)])) {
    const list = (config.channels[key] ?? []).map(portableLink);
    for (const { index, link } of [...(pending[key] ?? [])].sort((a, b) => a.index - b.index)) {
      if (list.some((l) => linkIdentity(l) === linkIdentity(link))) continue;
      list.splice(Math.min(index, list.length), 0, link);
    }
    if (list.length > 0) channels[key] = list;
  }
  const { agent, ...rest } = config.settings;
  const settings: Record<string, unknown> = { agent: { id: agent.id, args: [...agent.args] } };
  for (const key of SYNCED_SETTINGS) {
    if (key !== "agent") settings[key] = rest[key];
  }
  return {
    channels,
    prompts: structuredClone(config.prompts),
    settings: settings as SyncContent["settings"],
  };
}

/** Finds this computer's checkout of a synced repo, or null if it has none. */
export type Locator = (link: SyncedLink) => Promise<string | null>;

/**
 * Look for a synced repo among the checkouts discovery finds (the usual
 * folders, settings.repoSearchRoots, and beside the repos already linked):
 * by origin first, then by owner/repo on any host, since one computer's
 * github.com can be another's ssh alias for it. A repo with no origin is
 * matched by name, and only when exactly one checkout has it.
 */
export function makeLocator(config: Config): Locator {
  let found: Promise<Array<{ name: string; path: string }>> | null = null;
  return async (link) => {
    const { repoSearchRoots, worktreesRoot } = config.settings;
    found ??= discoverRepos({
      channel: "",
      linkedRepos: linkedRepoPaths(config),
      worktreesRoot,
      roots: repoSearchRoots.length > 0 ? repoSearchRoots.map(expandPath) : undefined,
      limit: 1000,
    });
    const candidates = await found;
    const name = link.name.toLowerCase();
    const named = candidates.filter((c) => c.name.toLowerCase() === name);
    if (!link.remote) return named.length === 1 ? named[0]!.path : null;

    const tail = remotePath(link.remote);
    let sameTail: string | null = null;
    // Same-named folders first: the likeliest, so most runs stop there.
    for (const candidate of [...named, ...candidates.filter((c) => !named.includes(c))]) {
      const remote = await repoRemote(candidate.path);
      if (remote === link.remote) return candidate.path;
      if (!sameTail && remote && remotePath(remote) === tail) sameTail = candidate.path;
    }
    return sameTail;
  };
}

/** Learn the origin of every linked repo that does not have one recorded yet. */
async function fillRemotes(config: Config): Promise<void> {
  await Promise.all(
    allLinks(config)
      .filter((link) => !link.remote)
      .map(async (link) => {
        link.remote = await repoRemote(link.repoPath);
      }),
  );
}

/**
 * Make the config say what `content` says: its synced settings and prompts
 * as they are, and its links on this computer's checkouts. Returns the links
 * with no checkout here yet.
 */
export async function applyContent(
  config: Config,
  content: SyncContent,
  locate: Locator,
  now = new Date(),
): Promise<Record<string, PendingLink[]>> {
  for (const [key, value] of Object.entries(content.settings)) {
    if (value === undefined) continue;
    if (key === "agent") {
      const agent = value as { id: string; args: string[] };
      const current = config.settings.agent;
      // A custom command belongs to the agent it was set for, as `sidequest agents` has it.
      config.settings.agent = {
        id: agent.id,
        args: [...agent.args],
        command: current.id === agent.id ? current.command : "",
      };
    } else {
      (config.settings as Record<string, unknown>)[key] = value;
    }
  }
  config.prompts = structuredClone(content.prompts);

  const known = new Map<string, RepoLink>();
  for (const link of allLinks(config)) {
    const id = linkIdentity(portableLink(link));
    if (!known.has(id)) known.set(id, link);
  }

  const channels: Config["channels"] = {};
  const pending: Record<string, PendingLink[]> = {};
  for (const [name, links] of Object.entries(content.channels)) {
    const key = channelKey(name);
    if (!key) continue;
    const out: RepoLink[] = [];
    for (const [index, synced] of links.entries()) {
      const id = linkIdentity(synced);
      const here = (config.channels[key] ?? []).find((l) => linkIdentity(portableLink(l)) === id);
      const repoPath = here?.repoPath ?? known.get(id)?.repoPath ?? (await locate(synced));
      if (!repoPath) {
        (pending[key] ??= []).push({ index, link: synced });
        continue;
      }
      if (out.some((l) => l.repoPath === repoPath)) continue;
      out.push({
        repoPath,
        channel: key,
        baseBranch: synced.baseBranch,
        label: synced.label,
        remote: synced.remote,
        linkedBy: here?.linkedBy ?? "sync",
        linkedAt: here?.linkedAt ?? now.toISOString(),
      });
    }
    if (out.length > 0) channels[key] = out;
  }
  config.channels = channels;
  return pending;
}

const syncStateSchema = z.object({
  /** The content this computer and Slack last agreed on: the merge's base. */
  base: syncContentSchema.nullable().default(null),
  pending: z
    .record(z.string(), z.array(z.object({ index: z.number().int().min(0), link: syncedLinkSchema })))
    .default({}),
  /** When this computer last agreed with Slack, and who had written the note then. */
  syncedAt: z.string().default(""),
  from: z.string().default(""),
});
export type SyncState = z.infer<typeof syncStateSchema>;

/** sync.json, or a fresh start when it is missing or unreadable: the merge then unions both sides. */
export async function loadSyncState(): Promise<SyncState> {
  try {
    return syncStateSchema.parse(JSON.parse(await readFile(syncStateFile(), "utf8")));
  } catch {
    return syncStateSchema.parse({});
  }
}

async function saveSyncState(state: SyncState): Promise<void> {
  const file = syncStateFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface SyncPlan {
  /** The config took changes from Slack. */
  pulled: boolean;
  /** Which computer wrote what was pulled. */
  from: string;
  /** The note to write back, when Slack's copy is missing or behind; null when it is current. */
  push: string | null;
  /** Slack's message was not a note that reads, and is to be replaced. */
  replacedInvalid: boolean;
  /** Synced links still waiting for a checkout on this computer. */
  pending: number;
  /**
   * Call once `push` is in Slack. Until then the base stays where it was,
   * so a write that failed is merged again on the next run rather than
   * read as Slack having undone this computer's changes.
   */
  commit(): Promise<void>;
}

/**
 * One round of sync, given the note's text as Slack has it (null for no
 * note yet): merge it with the config, save the result locally, and say what
 * Slack needs written back.
 */
export async function syncConfig(
  noteText: string | null,
  options: { locate?: Locator; now?: Date; from?: string } = {},
): Promise<SyncPlan> {
  let note: SyncNote | null = null;
  let replacedInvalid = false;
  if (noteText !== null) {
    try {
      note = decodeNote(noteText);
    } catch {
      replacedInvalid = true;
    }
  }
  const now = options.now ?? new Date();
  const state = await loadSyncState();

  const round = await updateConfig(async (config) => {
    await fillRemotes(config);
    const local = localContent(config, state.pending);
    const merged = note ? mergeContent(state.base, local, note.content) : local;
    const pending = await applyContent(config, merged, options.locate ?? makeLocator(config), now);
    return { local, merged, pending };
  }, { onlyIfChanged: true });

  const pulled = !same(round.local, round.merged);
  const push = note && same(note.content, round.merged)
    ? null
    : encodeNote(round.merged, now, options.from ?? machineName());
  const settled = (from: string): SyncState => ({
    base: round.merged,
    pending: round.pending,
    syncedAt: now.toISOString(),
    from,
  });

  if (push === null) {
    await saveSyncState(settled(note?.from ?? state.from));
  } else {
    // The pending links are this computer's own business, true whatever Slack says.
    await saveSyncState({ ...state, pending: round.pending });
  }
  return {
    pulled,
    from: note?.from ?? "",
    push,
    replacedInvalid,
    pending: Object.values(round.pending).reduce((n, list) => n + list.length, 0),
    commit: () => saveSyncState(settled(options.from ?? machineName())),
  };
}
