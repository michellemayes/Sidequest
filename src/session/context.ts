import type { PromptContext } from "../config/prompts.js";
import type { Ticket } from "../config/tickets.js";
import { stripSlackMarkup } from "../util/slug.js";
import type { MessageContext } from "./create.js";

export interface ContextExtras {
  branch: string;
  baseBranch: string;
  repo: string;
  worktree: string;
  threadLimit: number;
  ticket: Ticket | null;
  attachments: string;
}

export function buildContext(message: MessageContext, extras: ContextExtras): PromptContext {
  return {
    author: message.authorName,
    channel: message.channelName,
    message: quote(stripSlackMarkup(message.text)),
    thread: formatThread(message.threadMessages, extras.threadLimit),
    permalink: message.permalink,
    date: messageDate(message.ts).toISOString(),
    branch: extras.branch,
    baseBranch: extras.baseBranch,
    repo: extras.repo,
    worktree: extras.worktree,
    ticket: extras.ticket?.url ?? "",
    ticketId: extras.ticket?.id ?? "",
    question: formatQuestion(message.question ?? ""),
    attachments: extras.attachments,
  };
}

/**
 * Slack renders a message's timestamp as epoch seconds with a sub-second
 * suffix. The overlay reads it off the DOM when it can; when it cannot, the
 * message is still worth a session, so fall back to now rather than to 1970.
 */
function messageDate(ts: string): Date {
  const seconds = Number.parseInt(ts.split(".")[0] ?? "", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/** Markdown blockquote, so the report is visually separate from instructions. */
function quote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "> (the message had no text)";
  return trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatThread(
  messages: Array<{ author: string; text: string }>,
  limit: number,
): string {
  if (limit <= 0 || messages.length === 0) return "";
  const slice = messages.slice(-limit);
  const body = slice
    .map((m) => `**@${m.author}:** ${stripSlackMarkup(m.text).trim()}`)
    .join("\n\n");
  return `\n### Thread replies\n${body}\n`;
}

/** The Ask box's text, set apart like the thread so it reads as mine, not the report's. */
function formatQuestion(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return `\n## My question\n${trimmed}\n`;
}
