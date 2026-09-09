import { slugify, stripSlackMarkup, timeFragment } from "../util/slug.js";
import type { PromptKey } from "../config/schema.js";

export interface BranchNameInput {
  promptKey: PromptKey;
  branchPrefix: string;
  messageText: string;
  /** Slack message ts, used when the message has no usable words. */
  messageTs: string;
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
  const stem = words.length > 0 ? words : `msg-${input.messageTs.replace(/\./g, "")}`;
  return `${input.branchPrefix}/${stem}-${timeFragment(input.now ?? new Date())}`;
}

/**
 * Warp resolves deeplinks against this name case-insensitively, so it must be
 * unique across concurrent sessions and safe in a filename.
 */
export function warpConfigName(branch: string): string {
  return `ccslack-${slugify(branch, 60)}`;
}

/** The tab title shown in Warp. */
export function tabTitle(promptLabel: string, repoLabel: string): string {
  return `${promptLabel} · ${repoLabel}`;
}
