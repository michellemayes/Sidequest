import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, type ControlHandler } from "../src/control/server.js";
import { appSessions, branchWords, createAppHandler, PROTOCOL_VERSION, sessionTitle, type AppHost } from "../src/control/app.js";
import type { AskRequest } from "../src/cdp/requests.js";
import { configFile } from "../src/config/paths.js";
import { loadConfig } from "../src/config/store.js";
import { loadHistory, recordSession, type HistoryEntry } from "../src/session/history.js";
import type { SessionStatus } from "../src/session/status.js";
import { exists } from "../src/util/fs.js";

let root: string;
const savedHome = process.env.SIDEQUEST_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sq-control-"));
  process.env.SIDEQUEST_HOME = root;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SIDEQUEST_HOME;
  else process.env.SIDEQUEST_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

/** A client that reads the server's lines as they come. */
async function client(path: string): Promise<{ socket: Socket; next: () => Promise<Record<string, unknown>>; send: (v: unknown) => void }> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  return {
    socket,
    send: (v) => socket.write(`${typeof v === "string" ? v : JSON.stringify(v)}\n`),
    next: () =>
      new Promise((resolve) => {
        const line = lines.shift();
        if (line !== undefined) resolve(JSON.parse(line));
        else waiting.push((l) => resolve(JSON.parse(l)));
      }),
  };
}

describe("ControlServer", () => {
  let server: ControlServer | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await server?.close();
    server = null;
  });

  async function start(handle: ControlHandler): Promise<string> {
    const path = join(root, "control.sock");
    server = new ControlServer({ path, handle });
    await server.listen();
    return path;
  }

  it("answers each request with its own id, on a socket only its owner can open", async () => {
    const path = await start(async (request) => ({ ok: true, echo: request.op }));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const c = await client(path);
    sockets.push(c.socket);
    c.send({ id: 7, op: "hello" });
    expect(await c.next()).toEqual({ ok: true, echo: "hello", id: 7 });
  });

  it("turns a bad line or a throwing handler into an error reply, and keeps the connection", async () => {
    const path = await start(async (request) => {
      if (request.op === "boom") throw new Error("it broke");
      return { ok: true };
    });
    const c = await client(path);
    sockets.push(c.socket);
    c.send("not json");
    expect(await c.next()).toMatchObject({ id: null, error: "That line was not JSON." });
    c.send({ op: "no-id" });
    expect(await c.next()).toMatchObject({ error: "A request needs an id and an op." });
    c.send({ id: "a", op: "boom" });
    expect(await c.next()).toEqual({ id: "a", error: "it broke" });
    c.send({ id: "b", op: "fine" });
    expect(await c.next()).toEqual({ id: "b", ok: true });
  });

  it("sends events only to clients that subscribed, and knows who shows notifications", async () => {
    const path = await start(async (request, connection) => {
      if (request.op === "subscribe") {
        connection.subscribed = true;
        connection.takesNotices = request.notices === true;
      }
      return { ok: true };
    });
    const listener = await client(path);
    const quiet = await client(path);
    sockets.push(listener.socket, quiet.socket);
    expect(server!.takesNotices).toBe(false);
    listener.send({ id: 1, op: "subscribe", notices: true });
    await listener.next();
    expect(server!.takesNotices).toBe(true);

    server!.broadcast("sessions", { n: 1 });
    expect(await listener.next()).toEqual({ n: 1, event: "sessions" });
    // The quiet client's first line is the answer to its own request, not the event.
    quiet.send({ id: 2, op: "ping" });
    expect(await quiet.next()).toEqual({ id: 2, ok: true });
  });

  it("replaces a dead daemon's socket, and removes its own on close", async () => {
    const path = await start(async () => ({ ok: true }));
    await server!.close();
    server = new ControlServer({ path, handle: async () => ({ ok: true }) });
    await server.listen();
    expect(await exists(path)).toBe(true);
    await server.close();
    server = null;
    expect(await exists(path)).toBe(false);
  });
});

function entry(n: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: `1700000000.00${n}`,
    channel: "storefront-eng",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: `claude/fix-${n}`,
    worktreePath: `/wt/storefront/claude-fix-${n}`,
    repoPath: "/code/storefront",
    repoLabel: "storefront",
    createdAt: new Date(2026, 9, 1, 10, n).toISOString(),
    permalink: `https://acme.slack.com/archives/C1/p${n}`,
    ...extra,
  };
}

function status(extra: Partial<SessionStatus> = {}): SessionStatus {
  return { state: "working", commits: 0, dirty: false, pr: null, resultMs: null, resultPending: false, exitCode: null, ...extra };
}

describe("appSessions", () => {
  it("names a session for its message, as a reader sees it", () => {
    expect(sessionTitle(entry(1, { message: "\n  *Checkout* total is off — see <https://x.test/a|the cart>\nmore" }))).toBe(
      "Checkout total is off — see the cart",
    );
    expect(sessionTitle(entry(2))).toBe("Fix · claude/fix-2");
    expect(sessionTitle(entry(3, { message: "x".repeat(300) })).length).toBe(120);
  });

  it("reads a session with no message back from the words in its branch", () => {
    const branch = "investigate/jeff-zern-did-the-last-two-hours-match-20260929-2208";
    expect(sessionTitle(entry(1, { branch }))).toBe("Jeff zern did the last two hours match");
    expect(branchWords("ask/why-is-it-slow-20260929-2208-2")).toBe("Why is it slow");
    expect(branchWords("fix/msg-1700000000001-20260929-2208")).toBeNull();
    expect(branchWords("my-own-branch")).toBeNull();
  });

  it("stops asking about a session you marked done", () => {
    const statuses = new Map([
      ["claude/fix-1", status({ state: "answered", resultMs: 5, resultPending: true })],
      ["claude/fix-2", status({ state: "failed", exitCode: 1 })],
    ]);
    const doneAt = "2026-10-09T12:00:00.000Z";
    const list = appSessions([entry(1, { doneAt }), entry(2, { doneAt })], statuses, { postResults: "ask" });
    expect(list.map((s) => [s.doneAt, s.needsYou])).toEqual([[doneAt, false], [doneAt, false]]);
  });

  it("lists newest first, once per worktree, with the watcher's status and what needs you", () => {
    const history = [entry(1), entry(2), entry(3), { ...entry(1), createdAt: new Date(2026, 9, 2).toISOString() }];
    const statuses = new Map([
      ["claude/fix-1", status({ state: "committed", commits: 2, resultPending: true, resultMs: 5 })],
      ["claude/fix-2", status({ state: "failed", exitCode: 1 })],
    ]);
    const list = appSessions(history, statuses, { postResults: "ask" });
    expect(list.map((s) => s.branch)).toEqual(["claude/fix-1", "claude/fix-3", "claude/fix-2"]);
    expect(list[0]).toMatchObject({ id: "claude-fix-1", state: "committed", commits: 2, needsYou: true, resultPending: true });
    expect(list[1]).toMatchObject({ state: "unknown", needsYou: false });
    expect(list[2]).toMatchObject({ state: "failed", exitCode: 1, needsYou: true });
  });

  it("does not ask you about a reply that posts itself", () => {
    const statuses = new Map([["claude/fix-1", status({ resultPending: true })]]);
    expect(appSessions([entry(1)], statuses, { postResults: "auto" })[0]).toMatchObject({ resultPending: false, needsYou: false });
  });
});

describe("createAppHandler", () => {
  function fakeHost(over: Partial<AppHost> = {}): AppHost & { asked: AskRequest[]; posted: unknown[] } {
    const asked: AskRequest[] = [];
    const posted: unknown[] = [];
    return {
      asked,
      posted,
      ask: async (request) => {
        asked.push(request);
        return { ok: true, op: request.op };
      },
      postReply: async (job) => {
        posted.push(job);
        return true;
      },
      statusSnapshot: new Map(),
      attachedCount: 1,
      lastSweep: { targets: 1, matched: 1 },
      sweepNow: async () => undefined,
      broadcastConfig: async () => undefined,
      ...over,
    };
  }
  const conn = () => ({ subscribed: false, takesNotices: false });

  it("says which protocol it speaks", async () => {
    const reply = await createAppHandler(fakeHost())({ id: 1, op: "hello" }, conn());
    expect(reply).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it("hands the overlay's own ops to its handlers", async () => {
    const host = fakeHost();
    const handle = createAppHandler(host);
    await handle({ id: 1, op: "reopen", branch: "claude/fix-1" }, conn());
    await handle({ id: 2, op: "follow-up", branch: "claude/fix-1", question: "and the email" }, conn());
    expect(host.asked.map((r) => r.op)).toEqual(["reopen", "follow-up"]);
    expect(host.asked[1]).toMatchObject({ question: "and the email" });
  });

  it("subscribes a connection, with or without notifications", async () => {
    const c = conn();
    await createAppHandler(fakeHost())({ id: 1, op: "subscribe", notices: true }, c);
    expect(c).toEqual({ subscribed: true, takesNotices: true });
  });

  it("merges settings, and refuses one the config file would refuse without writing anything", async () => {
    const handle = createAppHandler(fakeHost());
    const reply = await handle({ id: 1, op: "set-config", settings: { terminal: "headless", reactions: true } }, conn());
    expect(reply).toMatchObject({ ok: true });
    expect((await loadConfig()).settings).toMatchObject({ terminal: "headless", reactions: true, notify: true });

    const before = await readFile(configFile(), "utf8");
    await expect(handle({ id: 2, op: "set-config", settings: { terminal: "hyperterm" } }, conn())).rejects.toThrow(
      /settings\.terminal/,
    );
    expect(await readFile(configFile(), "utf8")).toBe(before);
  });

  it("sets and removes prompt overrides, and lists hidden prompts so they can be shown again", async () => {
    const handle = createAppHandler(fakeHost());
    await handle({ id: 1, op: "set-config", prompts: { review: { hidden: true }, "write-test": { label: "Write a test", template: "Test {{message}}" } } }, conn());
    const listed = (await handle({ id: 2, op: "get-config" }, conn())) as { prompts: Array<{ key: string; hidden: boolean }> };
    expect(listed.prompts.find((p) => p.key === "review")).toMatchObject({ hidden: true });
    expect(listed.prompts.map((p) => p.key)).toContain("write-test");

    await handle({ id: 3, op: "set-config", prompts: { review: null, "write-test": null } }, conn());
    const config = await loadConfig();
    expect(config.prompts).toEqual({});
  });

  it("posts an edited reply through a Slack window, and says so when none is open", async () => {
    await recordSession(entry(1));
    const host = fakeHost();
    const handle = createAppHandler(host);
    await handle({ id: 1, op: "post-reply", branch: "claude/fix-1", text: "Fixed, see PR #4" }, conn());
    expect(host.posted[0]).toMatchObject({ branch: "claude/fix-1", text: "Fixed, see PR #4", permalink: entry(1).permalink });

    const closed = createAppHandler(fakeHost({ postReply: async () => false }));
    await expect(closed({ id: 2, op: "post-reply", branch: "claude/fix-1", text: "hi" }, conn())).rejects.toThrow(
      /No Slack window/,
    );
  });

  it("marks a session done, and not done again", async () => {
    await recordSession(entry(1));
    const handle = createAppHandler(fakeHost());
    expect(await handle({ id: 1, op: "mark-done", branch: "claude/fix-1" }, conn())).toEqual({ ok: true, branch: "claude/fix-1", done: true });
    expect((await loadHistory())[0]!.doneAt).toMatch(/^\d{4}-/);

    await handle({ id: 2, op: "mark-done", branch: "claude/fix-1", done: false }, conn());
    expect((await loadHistory())[0]!.doneAt).toBeUndefined();
    await expect(handle({ id: 3, op: "mark-done", branch: "claude/nope" }, conn())).rejects.toThrow(/not one Sidequest knows/);
  });

  it("dismisses a reply through the overlay's own result-posted", async () => {
    const host = fakeHost();
    await createAppHandler(host)({ id: 1, op: "dismiss-reply", branch: "claude/fix-1" }, conn());
    expect(host.asked[0]).toMatchObject({ op: "result-posted", branch: "claude/fix-1", dismissed: true });
  });

  it("says how many finished sessions can go, how sync stands, and how a failed run ended", async () => {
    const handle = createAppHandler(fakeHost());
    expect(await handle({ id: 1, op: "clean-preview" }, conn())).toEqual({ ok: true, removable: 0 });
    expect(await handle({ id: 2, op: "sync-status" }, conn())).toEqual({ ok: true, syncedAt: "", from: "", waiting: [] });

    const wt = join(root, "wt");
    await recordSession(entry(1, { worktreePath: wt }));
    const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    await mk(join(wt, ".sidequest"), { recursive: true });
    await wf(join(wt, ".sidequest", "agent.log"), "one\ntwo\nError: not authenticated\nsidequest: finished, exit 1\n");
    expect(await handle({ id: 3, op: "log-tail", branch: "claude/fix-1", lines: 2 }, conn())).toEqual({
      ok: true,
      lines: ["Error: not authenticated", "sidequest: finished, exit 1"],
    });
  });

  it("answers an op it does not know with an error", async () => {
    expect(await createAppHandler(fakeHost())({ id: 1, op: "teleport" }, conn())).toEqual({ error: "unknown op teleport" });
  });
});

describe("the Mac app's view of the protocol", () => {
  it("decodes a session list that still matches what the daemon sends", async () => {
    const { FIXTURE_PATH, fixtureSessions } = await import("./support/appFixture.js");
    const onDisk = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
    // Regenerate with test/support/appFixture.ts if this changes on purpose.
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(fixtureSessions())));
  });

  it("has a field for every setting in config.json", async () => {
    const { settingsSchema } = await import("../src/config/schema.js");
    const swift = await readFile(new URL("../mac/Sources/Sidequest/Daemon/Models.swift", import.meta.url), "utf8");
    const body = swift.slice(swift.indexOf("struct SidequestSettings"), swift.indexOf("}", swift.indexOf("struct SidequestSettings")));
    const fields = [...body.matchAll(/^\s+var (\w+):/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(Object.keys(settingsSchema.shape).sort());
  });
});
