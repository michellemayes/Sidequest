import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDebugPort } from "../src/cdp/launch.js";
import { sleep } from "../src/cdp/launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx");

/** A port nothing is listening on, so every sweep fails the way a stopped Slack does. */
const DEAD_PORT = 9399;

describe("the poll loop keeps the daemon alive", () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    child?.kill("SIGKILL");
    child = null;
  });

  /*
   * The failure this guards against looked like success: `sidequest start`
   * printed its banner, said "Ctrl-C to stop", and exited before the user
   * could look at Slack, because the poll timer was unref'd and no window had
   * been attached yet to hold the loop open. Nothing was left running to
   * attach when Slack did appear.
   */
  it("stays running when there is no window to attach to yet", async () => {
    child = spawn(TSX, [join(HERE, "support", "poll-forever.ts"), String(DEAD_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let exited: number | null | "running" = "running";
    child.once("exit", (code) => {
      exited = code;
    });

    const polling = new Promise<void>((resolve, reject) => {
      let out = "";
      child!.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("polling")) resolve();
      });
      setTimeout(() => reject(new Error(`never started polling: ${out}`)), 15_000);
    });
    await polling;

    // Well inside one poll interval: if the loop did not hold the process, it
    // is already gone by now.
    await sleep(1500);
    expect(exited).toBe("running");
  }, 25_000);
});

describe("inspectDebugPort", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  /**
   * A DevTools endpoint that answers exactly like the real one, on a port of
   * its own — fetch keeps sockets alive between tests, and a reused port hands
   * the next test the previous server's answers.
   */
  async function serve(version: Record<string, string>, targets: unknown[]): Promise<number> {
    server = createServer((req, res) => {
      const body = req.url?.startsWith("/json/version") ? version : targets;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as { port: number }).port;
  }

  const SLACK_PATTERN = "app\\.slack\\.com|/client/";

  it("reports a closed port as closed", async () => {
    const port = await inspectDebugPort(DEAD_PORT, SLACK_PATTERN);
    expect(port.open).toBe(false);
    expect(port.isSlack).toBe(false);
  });

  /*
   * The case that made doctor lie: a Chrome the user started with
   * --remote-debugging-port answers on 9222 exactly as Slack would, so an open
   * port alone said "Sidequest can attach" while start attached to a browser
   * with no Slack in it.
   */
  it("does not mistake another browser on the port for Slack", async () => {
    const fake = await serve(
      { Browser: "Chrome/124.0.6367.243", "User-Agent": "Mozilla/5.0 Chrome/124.0.6367.243 Safari/537.36" },
      [{ id: "1", type: "page", url: "https://example.com/", title: "", webSocketDebuggerUrl: "ws://x/1" }],
    );

    const port = await inspectDebugPort(fake, SLACK_PATTERN);
    expect(port.open).toBe(true);
    expect(port.isSlack).toBe(false);
    expect(port.matchingTargets).toBe(0);
    expect(port.browser).toBe("Chrome/124.0.6367.243");
  });

  it("recognises Slack from its user agent before a workspace has loaded", async () => {
    const fake = await serve(
      {
        Browser: "Chrome/124.0.6367.243",
        "User-Agent": "Mozilla/5.0 Slack/4.41.98 Chrome/124.0.6367.243 Electron/30.0.9",
      },
      [{ id: "1", type: "page", url: "about:blank", title: "", webSocketDebuggerUrl: "ws://x/1" }],
    );

    const port = await inspectDebugPort(fake, SLACK_PATTERN);
    expect(port.isSlack).toBe(true);
    expect(port.matchingTargets).toBe(0);
  });

  it("counts the windows a sweep would attach to", async () => {
    const fake = await serve(
      { Browser: "Chrome/124.0.6367.243", "User-Agent": "Mozilla/5.0 Slack/4.41.98 Electron/30.0.9" },
      [
        { id: "1", type: "page", url: "https://app.slack.com/client/T01/C01", title: "", webSocketDebuggerUrl: "ws://x/1" },
        { id: "2", type: "page", url: "https://app.slack.com/client/T02/C02", title: "", webSocketDebuggerUrl: "ws://x/2" },
        // On a Slack URL, and not a window: doctor would be overcounting if it
        // said three.
        { id: "3", type: "service_worker", url: "https://app.slack.com/sw.js", title: "", webSocketDebuggerUrl: "ws://x/3" },
        { id: "4", type: "page", url: "about:blank", title: "", webSocketDebuggerUrl: "ws://x/4" },
      ],
    );

    const port = await inspectDebugPort(fake, SLACK_PATTERN);
    expect(port.totalTargets).toBe(4);
    expect(port.matchingTargets).toBe(2);
    expect(port.isSlack).toBe(true);
  });
});
