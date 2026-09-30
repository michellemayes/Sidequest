import { describe, expect, it } from "vitest";
import { configSchema, type RepoLink } from "../src/config/schema.js";
import {
  addLink,
  linkedRepoPaths,
  linksForChannel,
  removeLink,
  repoForChannelName,
} from "../src/config/channels.js";
import { pageConfig } from "../src/config/pageConfig.js";
import type { HistoryEntry } from "../src/session/history.js";

function link(repoPath: string, extra: Partial<RepoLink> = {}): RepoLink {
  return { repoPath, channel: "", baseBranch: "", label: "", linkedBy: "", linkedAt: "", ...extra };
}

describe("channel links", () => {
  it("reads a config from before a channel could have several repos as a list of one", () => {
    const config = configSchema.parse({
      channels: { "eng-alerts": { repoPath: "/code/storefront", channel: "eng-alerts" } },
    });
    expect(linksForChannel(config, "#Eng-Alerts").map((l) => l.repoPath)).toEqual(["/code/storefront"]);
  });

  it("adds a second repo after the first, and updates one already there in place", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api"));
    addLink(config, "eng", link("/code/storefront", { baseBranch: "develop" }));
    const links = linksForChannel(config, "eng");
    expect(links.map((l) => l.repoPath)).toEqual(["/code/storefront", "/code/api"]);
    expect(links[0]!.baseBranch).toBe("develop");
    expect(links[0]!.channel).toBe("eng");
  });

  it("tells apart two checkouts with the same directory name", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/work/app"));
    const second = addLink(config, "eng", link("/code/side/app"));
    expect(second.label).toBe("side/app");
    expect(repoForChannelName(config, "eng", "side/app")?.repoPath).toBe("/code/side/app");
  });

  it("picks the named repo, by label or path, and the default otherwise", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api", { label: "API" }));
    expect(repoForChannelName(config, "eng")?.repoPath).toBe("/code/storefront");
    expect(repoForChannelName(config, "eng", "API")?.repoPath).toBe("/code/api");
    expect(repoForChannelName(config, "eng", "/code/api")?.repoPath).toBe("/code/api");
    expect(repoForChannelName(config, "eng", "storefront")?.repoPath).toBe("/code/storefront");
    expect(repoForChannelName(config, "eng", "gone")).toBeUndefined();
    expect(repoForChannelName(config, "elsewhere")).toBeUndefined();
  });

  it("removes one repo, then the channel with its last", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api"));
    expect(removeLink(config, "eng", "api").map((l) => l.repoPath)).toEqual(["/code/api"]);
    expect(linksForChannel(config, "eng").map((l) => l.repoPath)).toEqual(["/code/storefront"]);
    expect(removeLink(config, "eng", "nope")).toEqual([]);
    removeLink(config, "eng", "storefront");
    expect(config.channels.eng).toBeUndefined();
  });

  it("removes every repo when none is named", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api"));
    expect(removeLink(config, "eng")).toHaveLength(2);
    expect(config.channels.eng).toBeUndefined();
  });

  it("lists each repo once across channels", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api"));
    addLink(config, "ops", link("/code/api"));
    expect(linkedRepoPaths(config)).toEqual(["/code/storefront", "/code/api"]);
  });
});

describe("page config", () => {
  it("gives the page each channel's repo labels and the one its last session used", () => {
    const config = configSchema.parse({});
    addLink(config, "eng", link("/code/storefront"));
    addLink(config, "eng", link("/code/api"));
    addLink(config, "ops", link("/code/infra"));
    const entry = (repoPath: string, channel: string): HistoryEntry => ({
      ts: "1.0", channel, promptKey: "fix", promptLabel: "Fix", branch: "b",
      worktreePath: "/w", repoPath, repoLabel: "", createdAt: "2026-09-01T00:00:00Z",
    });
    const page = pageConfig(config, [
      entry("/code/storefront", "eng"),
      entry("/code/api", "eng"),
      // Since unlinked: not something to pick.
      entry("/code/old", "ops"),
    ]);
    expect(page.linkedChannels.sort()).toEqual(["eng", "ops"]);
    expect(page.repoLabels).toEqual({ eng: ["storefront", "api"], ops: ["infra"] });
    expect(page.lastRepos).toEqual({ eng: "api" });
    // Paths stay with the daemon.
    expect(JSON.stringify(page)).not.toContain("/code/");
  });
});
