import type { PromptConfig, PromptKey } from "./schema.js";

/**
 * The prompts on a Slack message: the first four on every one, and Linear,
 * GitHub and Jira only on a message that links one of their issues (see
 * src/config/tickets.ts). Users can override any
 * field per prompt in ~/.sidequest/config.json; anything they omit falls back to
 * the definition here.
 */
export const DEFAULT_PROMPTS: Record<PromptKey, PromptConfig> = {
  investigate: {
    label: "Investigate",
    emoji: "mag",
    branchPrefix: "investigate",
    reply: "Investigating this.",
    template: `You are investigating an issue reported in Slack. Do NOT change any code yet.

## The report
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
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
    reply: "Working on a fix.",
    template: `You are fixing an issue reported in Slack.

## The report
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
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
    reply: "Reviewing this.",
    template: `You are reviewing work referenced in Slack.

## The request
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
Slack permalink: {{permalink}}

## What I need
1. Work out what to review from the message above — a PR link, a branch, a file, or the current diff against {{baseBranch}}.
2. Review for correctness first: real bugs, broken edge cases, races, unhandled errors. Construct the concrete input that breaks each one.
3. Then note reuse, simplification and clarity issues worth fixing.
4. Skip style nits the repo's linter already covers.

Give me findings ordered most severe first, each with the file, the line, and what actually goes wrong. Say plainly if you find nothing serious. Do not change code unless I ask.`,
  },
  ask: {
    label: "Ask",
    emoji: "speech_balloon",
    branchPrefix: "ask",
    reply: "Looking into this: {{question}}",
    template: `From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
Slack permalink: {{permalink}}
{{question}}
Read this and the code it touches. If I asked something above, answer it; otherwise wait for my instructions.`,
  },
  linear: {
    label: "Linear",
    emoji: "ticket",
    branchPrefix: "linear",
    reply: "Picking up {{ticketId}}.",
    template: `You are working a Linear ticket shared in Slack.

## The ticket
{{ticketId}}: {{ticket}}

## Where it came up
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
Slack permalink: {{permalink}}

## What I need
1. Read the ticket in full first: description, comments, linked issues. Use your Linear tools if you have them; if you cannot reach Linear, say so and work from the Slack context above.
2. Find the root cause before changing anything — do not patch the symptom.
3. Make the smallest change that actually fixes it, and add or update a test that fails without it.
4. Run the repo's own lint, typecheck and test commands and get them green.
5. Commit on this branch ({{branch}}) with {{ticketId}} in the message, explaining the cause, not just the change.

If the ticket is wrong, already fixed, or needs a decision I should make, stop and say so instead of guessing.`,
  },
  github: {
    label: "GitHub",
    emoji: "ticket",
    branchPrefix: "issue",
    reply: "Picking up {{ticketId}}.",
    template: `You are working a GitHub issue shared in Slack.

## The issue
{{ticketId}}: {{ticket}}

## Where it came up
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
Slack permalink: {{permalink}}

## What I need
1. Read the issue in full first: description, comments, linked PRs. Use \`gh issue view {{ticket}} --comments\` if the gh CLI is available; if you cannot reach GitHub, say so and work from the Slack context above.
2. Find the root cause before changing anything — do not patch the symptom.
3. Make the smallest change that actually fixes it, and add or update a test that fails without it.
4. Run the repo's own lint, typecheck and test commands and get them green.
5. Commit on this branch ({{branch}}) explaining the cause, not just the change, and end the message with "Fixes {{ticketId}}" so GitHub closes the issue when it merges.

If the issue is wrong, already fixed, or needs a decision I should make, stop and say so instead of guessing.`,
  },
  jira: {
    label: "Jira",
    emoji: "ticket",
    branchPrefix: "jira",
    reply: "Picking up {{ticketId}}.",
    template: `You are working a Jira ticket shared in Slack.

## The ticket
{{ticketId}}: {{ticket}}

## Where it came up
From @{{author}} in #{{channel}} on {{date}}:
{{message}}
{{thread}}{{attachments}}
Slack permalink: {{permalink}}

## What I need
1. Read the ticket in full first: description, comments, linked issues. Use your Jira tools if you have them; if you cannot reach Jira, say so and work from the Slack context above.
2. Find the root cause before changing anything — do not patch the symptom.
3. Make the smallest change that actually fixes it, and add or update a test that fails without it.
4. Run the repo's own lint, typecheck and test commands and get them green.
5. Commit on this branch ({{branch}}) with {{ticketId}} at the start of the message, explaining the cause, not just the change.

If the ticket is wrong, already fixed, or needs a decision I should make, stop and say so instead of guessing.`,
  },
};

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
  /** Linear, GitHub or Jira issue URL, when the session is for one; empty otherwise. */
  ticket: string;
  /** The tracker's name for it (DATA-3051, owner/repo#123, ABC-123); empty otherwise. */
  ticketId: string;
  /** What the user typed into the Ask box, as its own section; empty otherwise. */
  question: string;
  /** Files attached to the message, saved into the worktree, as a list; empty when there are none. */
  attachments: string;
}

/** Every token a template may use, in the order `sidequest prompts` lists them. */
const TOKEN_NAMES: Record<keyof PromptContext, true> = {
  author: true,
  channel: true,
  message: true,
  thread: true,
  permalink: true,
  date: true,
  branch: true,
  baseBranch: true,
  repo: true,
  worktree: true,
  ticket: true,
  ticketId: true,
  question: true,
  attachments: true,
};
export const PROMPT_TOKENS = Object.keys(TOKEN_NAMES) as Array<keyof PromptContext>;

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

/**
 * The thread reply, rendered for Slack rather than for the agent: the repo is
 * its label (a path on your machine means nothing there) and the question is
 * just what you typed, without the prompt's heading. With nothing typed, a
 * reply like "Looking into this: {{question}}" ends at "Looking into this."
 */
export function renderReply(template: string, context: PromptContext, repoLabel: string, question: string): string {
  const rendered = renderPrompt(template, {
    ...context,
    repo: repoLabel,
    question: escapeSlack(question.trim()),
  }).trim();
  return question.trim() ? rendered : rendered.replace(/\s*:$/, ".");
}

/** chat.postMessage reads &, < and > as markup; typed text should post as typed. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
