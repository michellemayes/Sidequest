import { slugify, stripSlackMarkup, timeFragment } from "../util/slug.js";
import type { PromptKey } from "../config/schema.js";

export interface BranchNameInput {
  promptKey: PromptKey;
  branchPrefix: string;
  messageText: string;
  /** Slack message ts, used when the message has no usable words. */
  messageTs: string;
  /** Ticket key (DATA-3051, 123, ABC-123); leads the name so the tracker links the branch. */
  ticketId?: string;
  /** Keep the ticket key's case, for trackers that only match an upper-case key. */
  keepTicketCase?: boolean;
  now?: Date;
}

/**
 * Build a readable branch name: `<prefix>/<slug-of-message>-<date>`.
 *
 * The date fragment keeps two sessions cut from similar messages apart without
 * relying on the collision suffix, and makes the branch list sort sensibly.
 */
export function branchNameFor(input: BranchNameInput): string {
  const words = slugify(stripSlackMarkup(input.messageText), 40);
  const ticket = input.ticketId ? ticketFragment(input.ticketId, input.keepTicketCase ?? false) : "";
  const stem = ticket
    ? `${ticket}${words ? `-${words}` : ""}`
    : words.length > 0 ? words : `msg-${input.messageTs.replace(/\./g, "")}`;
  return `${input.branchPrefix}/${stem}-${timeFragment(input.now ?? new Date())}`;
}

/** The ticket key as a branch fragment: slugged, but upper-case if asked. */
function ticketFragment(id: string, keepCase: boolean): string {
  const slug = slugify(id, 20);
  return keepCase ? slug.toUpperCase() : slug;
}

/**
 * Warp resolves deeplinks against this name case-insensitively, so it must be
 * unique across concurrent sessions and safe in a filename.
 */
export function warpConfigName(branch: string): string {
  return `sidequest-${slugify(branch, 60)}`;
}

/** The tab title shown in Warp. */
export function tabTitle(promptLabel: string, repoLabel: string): string {
  return `${promptLabel} · ${repoLabel}`;
}
