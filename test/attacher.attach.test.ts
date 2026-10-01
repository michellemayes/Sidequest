import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Attacher, type AttacherEvent } from "../src/cdp/attacher.js";
import { recordSession } from "../src/session/history.js";

/**
 * A DevTools endpoint with one Slack window behind it, answering every
 * command except the ones a test tells it to fail.
 */
interface FakeSlack {
  port: number;
  /** Sockets ever opened to the window. */
  connections: number;
  /** Sockets open now. */
  open: () => number;
  /** Every command the window received, in order. */
  received: Array<{ method: string; params: Record<string, unknown> }>;
  /** Fail this command, once per entry. */
  failOnce: string[];
  /** Fire an event at every open socket, as the page would. */
  event: (method: string, params: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function fakeSlack(): Promise<FakeSlack> {
  const sockets = new Set<WebSocket>();
  const fake: Partial<FakeSlack> = { connections: 0, received: [], failOnce: [] };
  const server: Server = createServer((req, res) => {
    const { port } = server.address() as { port: number };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          id: "w1",
          type: "page",
          url: "https://app.slack.com/client/T1/C1",
          title: "Slack",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/w1`,
        },
      ]),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    fake.connections! += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const { id, method, params } = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      fake.received!.push({ method, params });
      const fail = fake.failOnce!.indexOf(method);
      if (fail >= 0) {
        fake.failOnce!.splice(fail, 1);
        socket.send(JSON.stringify({ id, error: { message: "nope", code: -32000 } }));
      } else {
        socket.send(JSON.stringify({ id, result: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as { port: number }).port;
  fake.open = () => sockets.size;
  fake.event = (method, params) => {
    for (const socket of sockets) socket.send(JSON.stringify({ method, params }));
  };
  fake.close = async () => {
    for (const socket of sockets) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake as FakeSlack;
}

let home: string;
let slack: FakeSlack;
let attacher: Attacher | null = null;
let events: AttacherEvent[];

function attach(watchIntervalMs: number | false = false): Attacher {
  attacher = new Attacher({
    cdpPort: slack.port,
    targetUrlPattern: "app\\.slack\\.com",
    watchIntervalMs,
    onEvent: (e) => events.push(e),
  });
  return attacher;
}

const types = (): string[] => events.map((e) => e.type);
const breakConfig = () => writeFile(join(home, "config.json"), "{ not json");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sidequest-attach-"));
  process.env.SIDEQUEST_HOME = home;
  slack = await fakeSlack();
  events = [];
});

afterEach(async () => {
  attacher?.stop();
  attacher = null;
  await slack.close();
  delete process.env.SIDEQUEST_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("attaching to a Slack window", () => {
  it("does not open a socket when the overlay cannot be built", async () => {
    await breakConfig();
    const a = attach();
    await a.sweepNow();
    expect(types()).toEqual(["attach-error"]);
    expect(slack.connections).toBe(0);
    expect(a.attachedCount).toBe(0);
  });

  /*
   * The leak this guards against: a failed attach left its socket open and
   * still handling clicks, the next poll attached again, and every click then
   * started one session per socket.
   */
  it("closes the socket of an attach that fails partway, and the retry is the only one", async () => {
    slack.failOnce.push("Page.addScriptToEvaluateOnNewDocument");
    const a = attach();
    await a.sweepNow();
    expect(types()).toEqual(["attach-error"]);
    await vi.waitFor(() => expect(slack.open()).toBe(0));

    await a.sweepNow();
    expect(a.attachedCount).toBe(1);
    expect(slack.connections).toBe(2);
    expect(slack.open()).toBe(1);
    // The failed one going away is not a window detaching.
    expect(types()).toEqual(["attach-error", "attached"]);
  });

  it("answers a request even when the config cannot be read", async () => {
    const a = attach();
    await a.sweepNow();
    expect(a.attachedCount).toBe(1);
    await breakConfig();

    slack.event("Runtime.bindingCalled", {
      name: "__sidequestAsk",
      payload: JSON.stringify({ id: "r1", op: "channel-status", channel: "eng" }),
    });
    await vi.waitFor(() => {
      const answer = slack.received.find(
        (m) => m.method === "Runtime.evaluate" && String(m.params.expression).startsWith("window.__sidequestResult &&"),
      );
      expect(answer).toBeDefined();
      const payload = JSON.parse(JSON.parse(String(answer!.params.expression).match(/\((".*")\)$/)![1]!)) as {
        id: string;
        error?: string;
      };
      expect(payload.id).toBe("r1");
      expect(payload.error).toBeTruthy();
    });
  });

  it("reports a config that breaks under the session watcher instead of rejecting", async () => {
    const a = attach(20);
    await a.start();
    await breakConfig();
    // A new session is a change, which pushes config to the windows.
    await recordSession({
      ts: "1.1",
      channel: "eng",
      promptKey: "investigate",
      promptLabel: "Investigate",
      branch: "investigate/x",
      worktreePath: join(home, "gone"),
      repoPath: join(home, "repo"),
      repoLabel: "repo",
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(types()).toContain("config-error"), { timeout: 3000 });
  });
});
