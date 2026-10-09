/**
 * A headless run as a conversation, for the Mac app.
 *
 * An agent with an event stream (Claude Code's stream-json) leaves what it
 * did in .sidequest/events.jsonl: what it said, which tools it used on what,
 * and how each run ended, with the runner's own markers between runs. Any
 * other agent has only its log, which is shown as it is.
 */
import { open } from "node:fs/promises";
import { headlessPaths } from "../terminals/headless.js";

export type TranscriptKind = "you" | "agent" | "tool" | "error" | "done" | "log";

export interface TranscriptItem {
  kind: TranscriptKind;
  text: string;
  /** For a tool: its name, e.g. "Bash" or "Edit". */
  tool?: string;
}

/** How much of the end of a stream or log is read; older runs fall off the top. */
const TAIL_BYTES = 2 * 1024 * 1024;
const TEXT_MAX = 4000;

async function tail(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function clip(text: string, max = TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line for what a tool was asked to do: the command, the file, the pattern. */
export function summarizeTool(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof args[key] === "string" && args[key]) return String(args[key]);
    return null;
  };
  const found =
    pick("command") ?? pick("file_path", "notebook_path", "path") ?? pick("url") ?? pick("query") ?? pick("pattern") ??
    pick("description", "prompt");
  if (found) return clip(found.split("\n")[0] ?? found, 300);
  const json = JSON.stringify(args);
  return clip(json === "{}" ? name : json, 300);
}

/** A follow-up's file as what you asked: its first paragraph after the heading. */
function followUpText(prompt: string): string {
  const paragraphs = prompt.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const body = paragraphs.find((p) => !p.startsWith("#")) ?? paragraphs[0] ?? "";
  return clip(body, 1000);
}

/** Claude Code's stream-json, with the runner's markers, as conversation items. */
export function claudeItems(stream: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      items.push({ kind: "log", text: clip(line) });
      continue;
    }
    const type = event.type;
    if (type === "sidequest") {
      if (event.event === "run-start" && event.mode === "followup" && typeof event.prompt === "string") {
        items.push({ kind: "you", text: followUpText(event.prompt) });
      } else if (event.event === "run-end" && typeof event.status === "number" && event.status !== 0) {
        items.push({ kind: "error", text: `The agent stopped with exit code ${event.status}.` });
      }
      continue;
    }
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
    if (type === "assistant") {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          items.push({ kind: "agent", text: clip(block.text.trim()) });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          items.push({ kind: "tool", tool: block.name, text: summarizeTool(block.name, block.input) });
        }
      }
    } else if (type === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && block.is_error === true) {
          const text = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n")
              : "";
          items.push({ kind: "error", text: clip(text.trim() || "A tool failed.", 600) });
        }
      }
    } else if (type === "result") {
      if (event.subtype === "success") {
        items.push({ kind: "done", text: "Finished." });
      } else {
        const errors = Array.isArray(event.errors) ? (event.errors as unknown[]).map(String).join("\n") : "";
        items.push({ kind: "error", text: clip(errors || `The run ended: ${String(event.subtype ?? "error")}.`) });
      }
    } else if (type === "system" && event.subtype === "permission_denied") {
      items.push({ kind: "error", text: clip(`Not allowed: ${String(event.tool_name ?? "a tool")}`) });
    }
  }
  return items;
}

/** A log as items, minus the runner's own bookkeeping lines. */
export function logItems(log: string): TranscriptItem[] {
  return log
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("sidequest: started"))
    .slice(-400)
    .map((line) => ({ kind: "log" as const, text: clip(line) }));
}

/** A session's conversation: from its event stream when it has one, else its log. */
export async function readTranscript(worktreePath: string): Promise<{ items: TranscriptItem[]; structured: boolean }> {
  const files = headlessPaths(worktreePath);
  const stream = await tail(files.eventsFile);
  if (stream !== null) return { items: claudeItems(stream), structured: true };
  return { items: logItems((await tail(files.logFile)) ?? ""), structured: false };
}
