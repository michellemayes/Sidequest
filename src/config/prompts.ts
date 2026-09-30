import type { PromptConfig, PromptKey } from "./schema.js";

/**
 * The prompts on a Slack message: the first three on every one, and Linear
 * only on a message that links a Linear issue. Users can override any
 * field per prompt in ~/.sidequest/config.json; anything they omit falls back to
 * the definition here.
 */
export const DEFAULT_PROMPTS: Record<PromptKey, PromptConfig> = {
  investigate: {
    label: "Investigate",
    emoji: "mag",
    branchPrefix: "investigate",
    template: `You are investigating an issue reported in Slack. Do NOT change any code yet.

## The report
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}
Slack permalink: {{permalink}}

## What I need
1. Reproduce or otherwise confirm the behaviour described above.
2. Trace it to the specific code responsible and explain the mechanism — what actually happens, not just where.
3. Note anything the report gets wrong or leaves ambiguous.
4. Finish with a short recommended fix and the files it would touch.

Report back in the terminal. Leave the working tree clean.`,
  },
  fix: {
    label: "Fix",
    emoji: "wrench",
    branchPrefix: "fix",
    template: `You are fixing an issue reported in Slack.

## The report
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}
Slack permalink: {{permalink}}

## What I need
1. Find the root cause before changing anything — do not patch the symptom.
2. Make the smallest change that actually fixes it.
3. Add or update a test that fails without your fix and passes with it.
4. Run the repo's own lint, typecheck and test commands and get them green.
5. Commit on this branch ({{branch}}) with a message explaining the cause, not just the change.

If the report turns out to be wrong or the fix needs a decision I should make, stop and say so instead of guessing.`,
  },
  review: {
    label: "Review",
    emoji: "eyes",
    branchPrefix: "review",
    template: `You are reviewing work referenced in Slack.

## The request
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}
Slack permalink: {{permalink}}

## What I need
1. Work out what to review from the message above — a PR link, a branch, a file, or the current diff against {{baseBranch}}.
2. Review for correctness first: real bugs, broken edge cases, races, unhandled errors. Construct the concrete input that breaks each one.
3. Then note reuse, simplification and clarity issues worth fixing.
4. Skip style nits the repo's linter already covers.

Give me findings ordered most severe first, each with the file, the line, and what actually goes wrong. Say plainly if you find nothing serious. Do not change code unless I ask.`,
  },
  linear: {
    label: "Linear",
    emoji: "ticket",
    branchPrefix: "linear",
    template: `You are working a Linear ticket shared in Slack.

## The ticket
{{ticketId}}: {{ticket}}

## Where it came up
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}
Slack permalink: {{permalink}}

## What I need
1. Read the ticket in full first: description, comments, linked issues. Use your Linear tools if you have them; if you cannot reach Linear, say so and work from the Slack context above.
2. Find the root cause before changing anything — do not patch the symptom.
3. Make the smallest change that actually fixes it, and add or update a test that fails without it.
4. Run the repo's own lint, typecheck and test commands and get them green.
5. Commit on this branch ({{branch}}) with {{ticketId}} in the message, explaining the cause, not just the change.

If the ticket is wrong, already fixed, or needs a decision I should make, stop and say so instead of guessing.`,
  },
};

/** A Linear issue link, with the issue identifier (e.g. DATA-3051) captured. */
export const LINEAR_ISSUE =
  /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/([a-z0-9-]+))?[^\s<>|]*/i;

export interface LinearTicket {
  url: string;
  /** Issue identifier, e.g. DATA-3051. */
  id: string;
  /** The title slug Linear puts in its URLs, when the link carries one. */
  slug: string;
}

/** The first Linear issue in a string. */
export function linearTicket(text: string): LinearTicket | null {
  const match = LINEAR_ISSUE.exec(text);
  if (!match) return null;
  return { url: match[0], id: match[1]!.toUpperCase(), slug: match[2] ?? "" };
}

export interface PromptContext {
  author: string;
  channel: string;
  message: string;
  thread: string;
  permalink: string;
  date: string;
  branch: string;
  baseBranch: string;
  repo: string;
  worktree: string;
  /** Linear issue URL, when the session is for one; empty otherwise. */
  ticket: string;
  /** Linear issue identifier, e.g. DATA-3051; empty otherwise. */
  ticketId: string;
}

const TOKEN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/**
 * Substitute {{tokens}} in a prompt template. Unknown tokens are left as-is so
 * a typo in a custom template is visible in the prompt rather than silently
 * becoming an empty string.
 */
export function renderPrompt(template: string, context: PromptContext): string {
  return template.replace(TOKEN, (match, key: string) => {
    const value = (context as unknown as Record<string, string | undefined>)[key];
    return value === undefined ? match : value;
  });
}
