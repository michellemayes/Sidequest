import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CdpSession } from "../src/cdp/client.js";

/** A DevTools endpoint that answers only Runtime.evaluate, and nothing else. */
let server: WebSocketServer;
let url = "";

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string };
      if (message.method === "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
      }
    });
  });
});

afterAll(() => {
  server.close();
});

describe("CdpSession.send", () => {
  it("rejects a command that gets no answer, and keeps working after", async () => {
    const session = await new CdpSession(url).connect();
    try {
      await expect(session.send("Page.enable", {}, 100)).rejects.toThrow(/Page.enable got no answer/);
      await expect(session.send("Runtime.evaluate", {}, 1000)).resolves.toEqual({ ok: true });
    } finally {
      session.close();
    }
  });
});
