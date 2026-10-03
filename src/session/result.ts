/**
 * The reply an agent leaves for the thread when it is done.
 *
 * Every session's prompt ends by asking the agent to write a short answer
 * for whoever asked into .sidequest/result.md. The daemon notices the file
 * (see src/session/status.ts), and the overlay, which is signed in to Slack,
 * offers it on the message or posts it in the thread. The agent writes
 * Markdown; Slack reads its own mrkdwn, so the text is converted on the way.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PostResults } from "../config/schema.js";
import { SESSION_DIR } from "../warp/autorun.js";
import { escapeSlack } from "../util/slack.js";

export const RESULT_FILE = "result.md";

/** Longer than this and it belongs in the session, not in a thread. */
export const MAX_RESULT_CHARS = 3000;

export function resultPath(worktreePath: string): string {
  return join(worktreePath, SESSION_DIR, RESULT_FILE);
}

/** The closing section every prompt gets, unless results are off. */
export function resultInstructions(mode: PostResults): string {
  if (mode === "off") return "";
  const who = mode === "auto"
    ? "Sidequest posts it in the Slack thread as me as soon as you write it"
    : "Sidequest offers it to me to post in the Slack thread as me";
  return `

## When you are done
Write a short reply for the Slack thread this came from to \`${SESSION_DIR}/${RESULT_FILE}\` (git ignores it): what you found or what you changed and why, in a few sentences of Markdown, written for whoever asked. ${who}, so do not sign it or address me. Leave it out if you stopped to ask me something; write it again if we pick the work back up and the answer changes.`;
}

export interface ResultFile {
  text: string;
  /** When it was last written, so a rewrite is a new result. */
  mtimeMs: number;
}

/** The result as the agent left it, or null when there is none yet. */
export async function readResult(worktreePath: string): Promise<ResultFile | null> {
  const file = resultPath(worktreePath);
  try {
    const [info, text] = await Promise.all([stat(file), readFile(file, "utf8")]);
    if (!text.trim()) return null;
    return { text, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** Only the file's timestamp: cheap enough to check every session on every poll. */
export async function resultMtime(worktreePath: string): Promise<number | null> {
  try {
    const info = await stat(resultPath(worktreePath));
    return info.size > 0 ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The text to post: converted to Slack's markup, cut to a thread-sized
 * length, carrying the pull request link when there is one and the agent
 * did not already mention it, and signed with the agent that wrote it, so
 * nobody in the thread takes it for something typed by hand.
 */
export function resultReply(markdown: string, extras: { prUrl?: string; agent?: string } = {}): string {
  let text = toSlack(markdown.trim());
  if (text.length > MAX_RESULT_CHARS) text = truncate(text, MAX_RESULT_CHARS);
  if (extras.prUrl && !markdown.includes(extras.prUrl)) text += `\n\nPull request: ${extras.prUrl}`;
  if (extras.agent) text += `\n\n${attribution(extras.agent)}`;
  return text;
}

/** The line every agent-written reply ends with. */
export function attribution(agent: string): string {
  return `_🤖 Written by ${escapeSlack(agent)}, an AI agent, via Sidequest_`;
}

/**
 * Markdown to Slack mrkdwn, for the handful of things an agent actually
 * writes: headings, bold and italics, links, lists, strikethrough and code.
 * Code is left alone apart from escaping, which Slack needs there too.
 */
export function toSlack(markdown: string): string {
  const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return escapeSlack(part.replace(/^```[^\n]*\n/, "```\n"));
      return convertProse(part);
    })
    .join("");
}

function convertProse(text: string): string {
  // Inline code keeps its contents verbatim; stash it while the rest converts.
  const code: string[] = [];
  let out = text.replace(/`[^`\n]+`/g, (match) => {
    code.push(escapeSlack(match));
    return `\u0000${code.length - 1}\u0000`;
  });

  out = escapeSlack(out);
  const BOLD = "\u0001";
  out = out
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, `${BOLD}$1${BOLD}`)
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replaceAll(BOLD, "*");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}

/** Cut at a line break near the limit, and close a code block the cut left open. */
function truncate(text: string, limit: number): string {
  let cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > limit * 0.6) cut = cut.slice(0, lastBreak);
  cut = cut.trimEnd();
  if ((cut.match(/```/g) ?? []).length % 2 === 1) cut += "\n```";
  return `${cut}\n…\n_The full write-up is in the session._`;
}
