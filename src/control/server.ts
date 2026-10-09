/**
 * The daemon's door for the Mac app.
 *
 * The overlay talks to the daemon through the DevTools binding Slack's
 * window gives it. The app has no window to go through, so the daemon also
 * listens on a Unix socket under the config root: one JSON object per line
 * each way. A line with an `id` is a request and gets one answer carrying the
 * same id; a line the daemon sends with an `event` and no id is news for the
 * connections that subscribed to it.
 *
 * The socket is created with only its owner allowed in (and sits in the
 * config root, which is 0700), so only your own user can connect, as with
 * the history and config files beside it.
 */
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { describeError } from "../util/errors.js";
import { log } from "../util/log.js";

/** A request from a client: what to do, and the id to answer with. */
export interface ControlRequest {
  id: string | number;
  op: string;
  [key: string]: unknown;
}

/** One client, as the handler sees it. */
export interface ControlConnection {
  /** Asked for events with `subscribe`. */
  subscribed: boolean;
  /** Said it shows notifications itself, so the daemon need not. */
  takesNotices: boolean;
}

export type ControlHandler = (
  request: ControlRequest,
  connection: ControlConnection,
) => Promise<Record<string, unknown>>;

/** A request line longer than this is dropped with the connection: nothing the app sends comes near it. */
const MAX_LINE = 4 * 1024 * 1024;

interface Client extends ControlConnection {
  socket: Socket;
}

export class ControlServer {
  private server: Server | null = null;
  private readonly clients = new Set<Client>();

  constructor(private readonly options: { path: string; handle: ControlHandler }) {}

  /**
   * Start listening. Only one daemon runs at a time (it holds the daemon
   * lock), so a socket already at the path is a dead daemon's and is replaced.
   */
  async listen(): Promise<void> {
    await rm(this.options.path, { force: true });
    const server = createServer((socket) => this.accept(socket));
    // Created with no group or other bits, rather than chmod'ed after: there
    // is then no moment at which another user could connect.
    const umask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.path, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(umask);
    }
    await chmod(this.options.path, 0o600);
    server.on("error", (err) => log.warn(`control socket: ${describeError(err).message}`));
    this.server = server;
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.options.path, { force: true }).catch(() => undefined);
  }

  /** Send an event to every subscribed client. */
  broadcast(event: string, payload: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ ...payload, event })}\n`;
    for (const client of this.clients) {
      if (client.subscribed && !client.socket.destroyed) client.socket.write(line);
    }
  }

  /** Whether some subscribed client shows notifications itself. */
  get takesNotices(): boolean {
    for (const client of this.clients) if (client.subscribed && client.takesNotices) return true;
    return false;
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  private accept(socket: Socket): void {
    const client: Client = { socket, subscribed: false, takesNotices: false };
    this.clients.add(client);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void this.handleLine(client, line);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => this.clients.delete(client));
  }

  private async handleLine(client: Client, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      request = parsed as ControlRequest;
    } catch {
      this.send(client, { id: null, error: "That line was not JSON." });
      return;
    }
    const id = typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
    if (id === null || typeof request.op !== "string") {
      this.send(client, { id, error: "A request needs an id and an op." });
      return;
    }
    let reply: Record<string, unknown>;
    try {
      reply = await this.options.handle(request, client);
    } catch (err) {
      const { message, hint } = describeError(err);
      reply = { error: message, hint };
    }
    this.send(client, { ...reply, id });
  }

  private send(client: Client, payload: Record<string, unknown>): void {
    if (!client.socket.destroyed) client.socket.write(`${JSON.stringify(payload)}\n`);
  }
}
