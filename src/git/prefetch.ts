import { repoForChannelName } from "../config/channels.js";
import type { Config } from "../config/schema.js";
import { log } from "../util/log.js";
import { defaultBranchCached, fetchQuietly, locateRepoCached } from "./repo.js";

/**
 * A fetch that finished this recently is as good as a new one: the base will
 * rarely have moved, and when it has the agent can pull. Skipping it takes
 * the slowest step off a click that follows another, or follows the menu
 * opening.
 */
export const FETCH_FRESH_MS = 60_000;

/**
 * Keeps one fetch per repo and base in flight at a time, and remembers when
 * each last worked, for as long as the daemon runs.
 */
export class FetchTracker {
  private readonly running = new Map<string, Promise<void>>();
  /** The latest fetch started in each repo, so the next one queues behind it. */
  private readonly latest = new Map<string, Promise<void>>();
  private readonly fetchedAt = new Map<string, number>();

  constructor(
    private readonly fetcher: (root: string, baseBranch: string) => Promise<boolean> = fetchQuietly,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Fetch the base, or join the fetch of it already running. Null when one
   * finished recently enough that there is nothing to wait for. Never rejects.
   */
  fetch(root: string, baseBranch: string): Promise<void> | null {
    const key = `${root}\0${baseBranch}`;
    const running = this.running.get(key);
    if (running) return running;
    const last = this.fetchedAt.get(key);
    if (last !== undefined && this.now() - last < FETCH_FRESH_MS) return null;

    // Two fetches in one repo at once can trip over each other's ref locks,
    // so a fetch of another base waits for the one before it.
    const before = this.latest.get(root) ?? Promise.resolve();
    const started: Promise<void> = before
      .then(() => this.fetcher(root, baseBranch))
      .then(
        (ok) => {
          if (ok) this.fetchedAt.set(key, this.now());
        },
        () => {},
      )
      .finally(() => {
        this.running.delete(key);
        if (this.latest.get(root) === started) this.latest.delete(root);
      });
    this.running.set(key, started);
    this.latest.set(root, started);
    return started;
  }
}

/** The daemon's fetches, shared by the clicks and the prefetches. */
export const fetches = new FetchTracker();

/**
 * Start fetching the base a session in this channel would be cut from, so
 * that by the time a prompt is picked from the menu there is nothing left to
 * wait for. Does nothing when fetching is turned off or the repo has no remote.
 */
export async function prefetchForChannel(config: Config, channelName: string, repo: string): Promise<void> {
  if (!config.settings.fetchBeforeCreate) return;
  const link = repoForChannelName(config, channelName, repo);
  if (!link) return;
  const found = await locateRepoCached(link.repoPath);
  if (!found.hasRemote) return;
  const baseBranch = link.baseBranch.trim() || (await defaultBranchCached(found));
  const fetching = fetches.fetch(found.root, baseBranch);
  if (fetching) {
    log.debug(`prefetching origin/${baseBranch} in ${found.root}`);
    await fetching;
  }
}
