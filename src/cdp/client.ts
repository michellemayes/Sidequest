import WebSocket from "ws";
import { log } from "../util/log.js";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/**
 * DevTools target types that can hold Slack's UI. Slack's window is a `page`,
 * but Electron renders embedded content in `webview` targets, and a build that
 * puts the workspace in one would otherwise look like an empty browser.
 */
const ATTACHABLE_TYPES = new Set(["page", "webview"]);

/**
 * Whether a sweep would drive this target. Shared with the port inspection in
 * launch.ts, so what doctor counts is what start would attach to — a service
 * worker on a Slack URL matches the pattern and is not a window.
 */
export function isAttachableTarget(target: CdpTarget, pattern: RegExp): boolean {
  return (
    ATTACHABLE_TYPES.has(target.type) &&
    pattern.test(target.url ?? "") &&
    Boolean(target.webSocketDebuggerUrl)
  );
}

type Handler = (params: Record<string, unknown>) => void;

interface Waiter {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

/** Emitted locally when the socket closes, so callers can drop the session. */
export const CLOSE_EVENT = "__close";

/**
 * A minimal Chrome DevTools Protocol client — enough to enable a domain,
 * install a binding, and evaluate scripts in a page. Slack's desktop app is
 * Electron, so this is how we reach its renderer.
 */
export class CdpSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Waiter>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;

  constructor(private readonly wsUrl: string) {}

  connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      // Runtime.evaluate results carry whole message bodies, so the default
      // payload cap is too small.
      const socket = new WebSocket(this.wsUrl, {
        perMessageDeflate: false,
        maxPayload: 64 * 1024 * 1024,
      });
      this.ws = socket;

      const onError = (err: Error) => reject(err);
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        // Past the handshake, a socket error just means the window went away.
        socket.on("error", () => undefined);
        resolve(this);
      });

      socket.on("message", (data) => this.onMessage(data.toString()));
      socket.on("close", () => {
        this.closed = true;
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error("cdp connection closed"));
        }
        this.pending.clear();
        this.emit(CLOSE_EVENT, {});
      });
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);

      const error = message.error as { message?: string; code?: number } | undefined;
      if (error) waiter.reject(new Error(`${error.message} (${error.code})`));
      else waiter.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }

    if (typeof message.method === "string") {
      this.emit(message.method, (message.params as Record<string, unknown>) ?? {});
    }
  }

  on(method: string, handler: Handler): void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const handler of this.handlers.get(method) ?? []) {
      try {
        handler(params);
      } catch (err) {
        log.warn(`cdp handler for ${method} threw`, err);
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.ws;
    if (this.closed || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("cdp connection is not open"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Already gone.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`devtools endpoint returned ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

export async function devtoolsVersion(port: number): Promise<Record<string, string>> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`devtools endpoint returned ${response.status}`);
  return (await response.json()) as Record<string, string>;
}
