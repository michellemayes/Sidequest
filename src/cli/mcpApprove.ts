/**
 * `sidequest mcp-approve --worktree <path>`: the MCP server a headless Claude
 * Code asks before anything its permission mode does not already allow
 * (--permission-prompt-tool mcp__sidequest__approve). Each question goes to
 * the daemon, which asks you in the Mac app; the answer comes back as the
 * JSON text Claude Code expects. Speaks just enough MCP over stdio for that:
 * one tool, newline-delimited JSON-RPC.
 */
import { createInterface } from "node:readline";
import { controlRequest } from "../control/client.js";

const TOOL = {
  name: "approve",
  description: "Ask the person running Sidequest whether a tool may be used.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Decision = { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

/** What the daemon decided, or no when it cannot be asked. */
export async function decide(worktree: string, tool: string, input: unknown, ask = controlRequest): Promise<Decision> {
  try {
    const reply = await ask({ op: "approval-request", worktree, tool, input });
    const decision = reply.decision as Decision | undefined;
    if (decision?.behavior === "allow") return { behavior: "allow", updatedInput: decision.updatedInput ?? input };
    if (decision?.behavior === "deny") return decision;
    return { behavior: "deny", message: String(reply.error ?? "Sidequest did not say yes.") };
  } catch {
    return { behavior: "deny", message: "Sidequest isn't running to ask, so this isn't allowed." };
  }
}

/** The answer to one message, or null for a notification. */
export async function answerMessage(
  message: RpcMessage,
  worktree: string,
  ask = controlRequest,
): Promise<Record<string, unknown> | null> {
  if (message.id === undefined || message.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "sidequest", version: "1" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      const args = (message.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      const decision = await decide(worktree, String(args.tool_name ?? ""), args.input ?? {}, ask);
      return reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
    }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } };
  }
}

export async function mcpApprove(options: { worktree: string }): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      continue;
    }
    // Answered as they come: one question waiting on you must not hold up a ping.
    void answerMessage(message, options.worktree).then((answer) => {
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
    });
  }
}
