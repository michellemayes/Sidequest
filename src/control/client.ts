/** One request to the running daemon over its control socket, from another process (`sidequest mcp-approve`). */
import { connect } from "node:net";
import { controlSocketFile } from "../config/paths.js";

export function controlRequest(
  payload: Record<string, unknown>,
  options: { path?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.path ?? controlSocketFile());
    let buffer = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          socket.destroy();
          reject(new Error("the daemon did not answer"));
        }, options.timeoutMs)
      : null;
    const done = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, ...payload })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        done(() => resolve(reply));
      } catch (err) {
        done(() => reject(err as Error));
      }
    });
    socket.on("error", (err) => done(() => reject(err)));
  });
}
