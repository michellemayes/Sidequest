import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/store.js";
import {
  decodeNote,
  encodeNote,
  loadSyncState,
  merge3,
  mergeContent,
  syncConfig,
  syncContentSchema,
  type Locator,
  type SyncContent,
} from "../src/config/sync.js";
import { normalizeRemote } from "../src/git/remote.js";

describe("normalizeRemote", () => {
  it("spells one repo the same however it is cloned", () => {
    for (const url of [
      "git@github.com:Acme/Storefront.git",
      "https://github.com/acme/storefront",
      "https://user@github.com/acme/storefront.git/",
      "ssh://git@github.com:22/acme/storefront.git",
    ]) {
      expect(normalizeRemote(url)).toBe("github.com/acme/storefront");
    }
  });

  it("has nothing to say for a remote that is a path on disk", () => {
    expect(normalizeRemote("/srv/git/app.git")).toBe("");
    expect(normalizeRemote("file:///srv/git/app.git")).toBe("");
    expect(normalizeRemote("")).toBe("");
  });
});

const content = (partial: Partial<SyncContent> = {}): SyncContent =>
  syncContentSchema.parse({ channels: {}, prompts: {}, settings: {}, ...partial });

describe("the settings note", () => {
  it("reads back what was written, prompts with markup and all", () => {
    const written = content({
      prompts: { fix: { reply: "On it <@U123> & co — see https://example.com" } },
      channels: { eng: [{ remote: "github.com/acme/app", name: "app", label: "", baseBranch: "main" }] },
      settings: { autoReply: true },
    });
    const text = encodeNote(written, new Date("2026-01-01T00:00:00Z"), "laptop");
    expect(text).not.toMatch(/[<>&]/);
    expect(text).toContain("laptop");
    const note = decodeNote(text);
    expect(note.from).toBe("laptop");
    expect(note.content).toEqual(written);
  });

  it("refuses a message that is not a note", () => {
    expect(() => decodeNote("just a message")).toThrow();
    expect(() => decodeNote("sidequest-sync:v1\n!!!")).toThrow();
  });
});

describe("merge3", () => {
  const remoteWins = <T>(_l: T | undefined, r: T | undefined) => r;

  it("takes whichever side changed a key, deletions included", () => {
    const base = { a: 1, b: 2, c: 3 };
    const local = { a: 10, b: 2, c: 3 };
    const remote = { a: 1, b: 2 };
    expect(merge3(base, local, remote, remoteWins)).toEqual({ a: 10, b: 2 });
  });

  it("hands a key both sides changed to the conflict rule", () => {
    expect(merge3({ a: 1 }, { a: 2 }, { a: 3 }, remoteWins)).toEqual({ a: 3 });
    expect(merge3(null, { a: 2, l: 1 }, { a: 3, r: 1 }, remoteWins)).toEqual({ a: 3, l: 1, r: 1 });
  });

  it("gives a channel both sides changed the repos of both", () => {
    const app = { remote: "github.com/acme/app", name: "app", label: "", baseBranch: "" };
    const api = { remote: "github.com/acme/api", name: "api", label: "", baseBranch: "" };
    const web = { remote: "github.com/acme/web", name: "web", label: "", baseBranch: "" };
    const merged = mergeContent(
      content({ channels: { eng: [app] } }),
      content({ channels: { eng: [app, api] } }),
      content({ channels: { eng: [app, web] } }),
    );
    expect(merged.channels.eng!.map((l) => l.name)).toEqual(["app", "web", "api"]);
  });
});

describe("syncConfig", () => {
  let root = "";
  const homes = { a: "", b: "" };
  const use = (machine: "a" | "b") => (process.env.SIDEQUEST_HOME = homes[machine]);

  const writeConfig = async (home: string, config: unknown) => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify(config));
  };
  /** A computer whose checkouts are the given remote -> path map. */
  const checkouts = (map: Record<string, string>): Locator => async (link) => map[link.remote] ?? null;

  const appLink = (repoPath: string) => ({
    repoPath,
    channel: "eng",
    baseBranch: "develop",
    label: "",
    remote: "github.com/acme/app",
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sidequest-sync-"));
    homes.a = join(root, "a");
    homes.b = join(root, "b");
    await writeConfig(homes.a, {
      settings: { autoReply: true, postResults: "auto", agent: { id: "codex", command: "/opt/codex", args: ["--x"] } },
      channels: { eng: [appLink("/Users/a/code/app")] },
      prompts: { "write-test": { label: "Write a test", template: "Write a test for {{text}}" } },
    });
    await writeConfig(homes.b, { settings: { worktreesRoot: "/b/worktrees", terminal: "iterm2" } });
  });

  afterEach(async () => {
    delete process.env.SIDEQUEST_HOME;
    await rm(root, { recursive: true, force: true });
  });

  /** Sync one machine against the note, writing back what it asks to; returns the note after. */
  async function round(machine: "a" | "b", note: string | null, locate: Locator) {
    use(machine);
    const plan = await syncConfig(note, { locate, from: machine });
    if (plan.push !== null) await plan.commit();
    return { plan, note: plan.push ?? note };
  }

  it("brings a second computer's channels, prompts and settings in line, on its own paths", async () => {
    const first = await round("a", null, checkouts({}));
    expect(first.plan.push).not.toBeNull();

    const second = await round("b", first.note, checkouts({ "github.com/acme/app": "/Users/b/src/app" }));
    expect(second.plan.pulled).toBe(true);
    expect(second.plan.push).toBeNull();

    const config = await loadConfig();
    expect(config.channels.eng).toMatchObject([{ repoPath: "/Users/b/src/app", baseBranch: "develop", linkedBy: "sync" }]);
    expect(config.prompts["write-test"]?.label).toBe("Write a test");
    expect(config.settings.autoReply).toBe(true);
    expect(config.settings.postResults).toBe("auto");
    // The agent, but not a command that is a path on the other computer.
    expect(config.settings.agent).toEqual({ id: "codex", command: "", args: ["--x"] });
    // What describes this computer stays as it was.
    expect(config.settings.worktreesRoot).toBe("/b/worktrees");
    expect(config.settings.terminal).toBe("iterm2");
  });

  it("carries a change either way, and keeps both when they touch different things", async () => {
    let note = (await round("a", null, checkouts({}))).note;
    note = (await round("b", note, checkouts({ "github.com/acme/app": "/b/app" }))).note;

    // B turns replies off; A, not having heard, links another channel.
    use("b");
    const b = JSON.parse(await readFile(join(homes.b, "config.json"), "utf8"));
    b.settings.autoReply = false;
    await writeFile(join(homes.b, "config.json"), JSON.stringify(b));
    note = (await round("b", note, checkouts({ "github.com/acme/app": "/b/app" }))).note;

    use("a");
    const a = JSON.parse(await readFile(join(homes.a, "config.json"), "utf8"));
    a.channels.web = [{ ...appLink("/Users/a/code/app"), channel: "web" }];
    await writeFile(join(homes.a, "config.json"), JSON.stringify(a));
    const merged = await round("a", note, checkouts({}));
    expect(merged.plan.pulled).toBe(true);
    expect(merged.plan.push).not.toBeNull();
    let config = await loadConfig();
    expect(config.settings.autoReply).toBe(false);
    expect(Object.keys(config.channels).sort()).toEqual(["eng", "web"]);

    await round("b", merged.note, checkouts({ "github.com/acme/app": "/b/app" }));
    config = await loadConfig();
    expect(config.channels.web).toMatchObject([{ repoPath: "/b/app" }]);
    expect(config.settings.autoReply).toBe(false);
  });

  it("unlinks on the other computer what was unlinked on one", async () => {
    let note = (await round("a", null, checkouts({}))).note;
    note = (await round("b", note, checkouts({ "github.com/acme/app": "/b/app" }))).note;

    use("a");
    const a = JSON.parse(await readFile(join(homes.a, "config.json"), "utf8"));
    a.channels = {};
    await writeFile(join(homes.a, "config.json"), JSON.stringify(a));
    note = (await round("a", note, checkouts({}))).note;

    await round("b", note, checkouts({ "github.com/acme/app": "/b/app" }));
    expect((await loadConfig()).channels).toEqual({});
  });

  it("keeps a repo that is not cloned here waiting, without taking that for a change", async () => {
    const note = (await round("a", null, checkouts({}))).note;
    const first = await round("b", note, checkouts({}));
    expect(first.plan.pending).toBe(1);
    expect(first.plan.push).toBeNull();
    expect((await loadConfig()).channels).toEqual({});
    expect((await loadSyncState()).pending.eng?.[0]?.link.remote).toBe("github.com/acme/app");

    const again = await round("b", note, checkouts({}));
    expect(again.plan.pulled).toBe(false);
    expect(again.plan.push).toBeNull();

    // Cloned since: it links itself.
    const cloned = await round("b", note, checkouts({ "github.com/acme/app": "/b/app" }));
    expect(cloned.plan.pending).toBe(0);
    expect(cloned.plan.push).toBeNull();
    expect((await loadConfig()).channels.eng).toMatchObject([{ repoPath: "/b/app" }]);
  });

  it("does not take a write that never reached Slack for Slack undoing it", async () => {
    let note = (await round("a", null, checkouts({}))).note;
    use("a");
    const a = JSON.parse(await readFile(join(homes.a, "config.json"), "utf8"));
    a.settings.autoReply = false;
    await writeFile(join(homes.a, "config.json"), JSON.stringify(a));
    const failed = await syncConfig(note, { locate: checkouts({}), from: "a" });
    expect(failed.push).not.toBeNull();
    // ...and the write fails, so no commit. The next round still has the change to send.
    const retry = await syncConfig(note, { locate: checkouts({}), from: "a" });
    expect(retry.push).not.toBeNull();
    expect((await loadConfig()).settings.autoReply).toBe(false);
    note = retry.push!;
    expect(decodeNote(note).content.settings.autoReply).toBe(false);
  });

  it("replaces a note that no longer reads with this computer's settings", async () => {
    use("a");
    const plan = await syncConfig("sidequest-sync:v1\nnot base64 at all!", { locate: checkouts({}), from: "a" });
    expect(plan.replacedInvalid).toBe(true);
    expect(decodeNote(plan.push!).content.channels.eng).toHaveLength(1);
  });
});
