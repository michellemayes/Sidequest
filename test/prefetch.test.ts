import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FETCH_FRESH_MS, FetchTracker, prefetchForChannel } from "../src/git/prefetch.js";
import { forgetRepos, locateRepoCached } from "../src/git/repo.js";
import { configSchema } from "../src/config/schema.js";

const exec = promisify(execFile);

/** A fetcher whose fetches finish only when the test says so. */
function controlledFetcher() {
  const calls: string[] = [];
  const finish: Array<(ok: boolean) => void> = [];
  const fetcher = (root: string, base: string): Promise<boolean> => {
    calls.push(`${root} ${base}`);
    return new Promise((resolve) => finish.push(resolve));
  };
  return { calls, finish, fetcher };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FetchTracker", () => {
  it("joins a fetch already running instead of starting another", async () => {
    const { calls, finish, fetcher } = controlledFetcher();
    const tracker = new FetchTracker(fetcher);
    const first = tracker.fetch("/repo", "main");
    const second = tracker.fetch("/repo", "main");
    expect(second).toBe(first);
    await tick();
    expect(calls).toEqual(["/repo main"]);
    finish[0]!(true);
    await first;
  });

  it("skips a fetch that worked within the last minute, and fetches again after", async () => {
    let now = 1_000_000;
    const { calls, finish, fetcher } = controlledFetcher();
    const tracker = new FetchTracker(fetcher, () => now);
    const first = tracker.fetch("/repo", "main");
    await tick();
    finish[0]!(true);
    await first;

    now += FETCH_FRESH_MS - 1;
    expect(tracker.fetch("/repo", "main")).toBeNull();

    now += 1;
    expect(tracker.fetch("/repo", "main")).not.toBeNull();
    await tick();
    expect(calls).toHaveLength(2);
  });

  it("does not count a failed fetch as fresh", async () => {
    const { calls, finish, fetcher } = controlledFetcher();
    const tracker = new FetchTracker(fetcher);
    const first = tracker.fetch("/repo", "main");
    await tick();
    finish[0]!(false);
    await first;
    expect(tracker.fetch("/repo", "main")).not.toBeNull();
    await tick();
    expect(calls).toHaveLength(2);
  });

  it("queues a fetch of another base in the same repo behind the running one", async () => {
    const { calls, finish, fetcher } = controlledFetcher();
    const tracker = new FetchTracker(fetcher);
    const main = tracker.fetch("/repo", "main");
    const dev = tracker.fetch("/repo", "dev");
    const other = tracker.fetch("/other", "main");
    await tick();
    expect(calls).toEqual(["/repo main", "/other main"]);
    finish[0]!(true);
    await main;
    await tick();
    expect(calls).toEqual(["/repo main", "/other main", "/repo dev"]);
    finish[2]!(true);
    finish[1]!(true);
    await Promise.all([dev, other]);
  });
});

describe("prefetchForChannel and the repo cache", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sidequest-prefetch-"));
    forgetRepos();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does nothing at all when fetchBeforeCreate is off", async () => {
    // A path that is not a repo: looking at it would throw.
    const config = configSchema.parse({
      settings: { fetchBeforeCreate: false },
      channels: { eng: [{ repoPath: join(root, "missing"), channel: "eng" }] },
    });
    await expect(prefetchForChannel(config, "eng", "")).resolves.toBeUndefined();
  });

  it("does nothing for a channel with no repo", async () => {
    const config = configSchema.parse({});
    await expect(prefetchForChannel(config, "eng", "")).resolves.toBeUndefined();
  });

  it("remembers a repo until told to forget, but still notices it is gone", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "# test\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "init"], { cwd: repo });

    const first = await locateRepoCached(repo);
    expect(first.hasRemote).toBe(false);
    await exec("git", ["remote", "add", "origin", join(root, "nowhere.git")], { cwd: repo });
    // Remembered: the new remote is not seen yet...
    expect((await locateRepoCached(repo)).hasRemote).toBe(false);
    // ...until a link change or a git failure clears what was remembered.
    forgetRepos();
    expect((await locateRepoCached(repo)).hasRemote).toBe(true);

    await rm(repo, { recursive: true, force: true });
    await expect(locateRepoCached(repo)).rejects.toThrow(/No such directory/);
  });
});
