import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDiscoveryCache, discoverRepos, scoreRepoForChannel } from "../src/git/discover.js";

describe("scoreRepoForChannel", () => {
  it("puts an exact name first", () => {
    expect(scoreRepoForChannel("storefront", "storefront")).toBe(100);
  });

  it("ignores the words that describe what a channel is for", () => {
    expect(scoreRepoForChannel("storefront", "storefront-eng")).toBe(95);
    expect(scoreRepoForChannel("payments-api", "eng-payments-api-alerts")).toBe(95);
  });

  it("matches a repo named inside a longer channel name", () => {
    expect(scoreRepoForChannel("checkout", "team-checkout-bugs")).toBeGreaterThan(0);
    expect(scoreRepoForChannel("web", "web-alerts")).toBeGreaterThan(
      scoreRepoForChannel("api", "web-alerts"),
    );
  });

  it("scores an unrelated repo zero", () => {
    expect(scoreRepoForChannel("dotfiles", "storefront-eng")).toBe(0);
    expect(scoreRepoForChannel("anything", "")).toBe(0);
  });
});

describe("discoverRepos", () => {
  let root: string;

  beforeEach(async () => {
    clearDiscoveryCache();
    root = await mkdtemp(join(tmpdir(), "sidequest-discover-"));
    const repo = async (...parts: string[]): Promise<void> => {
      await mkdir(join(root, ...parts, ".git"), { recursive: true });
    };
    await repo("code", "storefront");
    await repo("code", "dotfiles");
    await repo("code", "acme", "payments-api");
    // A worktree has a .git file, not a directory; it is not a checkout.
    await mkdir(join(root, "code", "linked-worktree"), { recursive: true });
    await writeFile(join(root, "code", "linked-worktree", ".git"), "gitdir: elsewhere\n");
    // Too deep to be worth the walk.
    await repo("code", "a", "b", "deep");
    // Sidequest's own worktrees are never suggestions.
    await repo("code", "sq-worktrees", "fix-something");
  });

  afterEach(async () => {
    clearDiscoveryCache();
    await rm(root, { recursive: true, force: true });
  });

  it("finds checkouts two levels down and ranks the channel's own first", async () => {
    const found = await discoverRepos({
      channel: "storefront-eng",
      linkedRepos: [],
      worktreesRoot: join(root, "code", "sq-worktrees"),
      roots: [join(root, "code")],
    });
    const names = found.map((r) => r.name);
    expect(names[0]).toBe("storefront");
    expect(found[0]!.score).toBeGreaterThan(0);
    expect(names).toContain("payments-api");
    expect(names).toContain("dotfiles");
    expect(names).not.toContain("linked-worktree");
    expect(names).not.toContain("deep");
    expect(names).not.toContain("fix-something");
  });

  it("searches beside repos that are already linked", async () => {
    const found = await discoverRepos({
      channel: "payments",
      linkedRepos: [join(root, "code", "acme", "payments-api")],
      worktreesRoot: join(root, "wt"),
      roots: [],
    });
    expect(found[0]!.name).toBe("payments-api");
    expect(found[0]!.linked).toBe(true);
  });
});
