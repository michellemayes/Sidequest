import type { PromptConfig, PromptKey } from "./schema.js";

/**
 * The three prompts that show up on every Slack message. Users can override any
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
