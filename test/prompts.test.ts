import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS, renderPrompt, renderReply, type PromptContext } from "../src/config/prompts.js";
import { PROMPT_KEYS } from "../src/config/schema.js";
import { shellQuote } from "../src/warp/autorun.js";
import { tomlString } from "../src/warp/configFiles.js";

const CONTEXT: PromptContext = {
  author: "michelle",
  channel: "eng-alerts",
  message: "> checkout is broken",
  thread: "\n### Thread replies\n**@sam:** since this morning\n",
  permalink: "https://slack.com/archives/C1/p1",
  date: "2026-09-09T14:32:00.000Z",
  branch: "fix/checkout-20260909-1432",
  baseBranch: "main",
  repo: "/Users/m/code/storefront",
  worktree: "/Users/m/.sidequest/worktrees/fix-checkout",
  ticket: "https://linear.app/acme/issue/DATA-3051/checkout-is-broken",
  ticketId: "DATA-3051",
  question: "",
  attachments: "",
};

describe("renderPrompt", () => {
  it("substitutes every known token", () => {
    const out = renderPrompt(
      "{{author}}|{{channel}}|{{message}}|{{permalink}}|{{branch}}|{{baseBranch}}|{{repo}}|{{worktree}}|{{date}}",
      CONTEXT,
    );
    expect(out).toBe(
      "michelle|eng-alerts|> checkout is broken|https://slack.com/archives/C1/p1|" +
        "fix/checkout-20260909-1432|main|/Users/m/code/storefront|" +
        "/Users/m/.sidequest/worktrees/fix-checkout|2026-09-09T14:32:00.000Z",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderPrompt("{{ author }}", CONTEXT)).toBe("michelle");
  });

  it("leaves an unknown token visible instead of blanking it", () => {
    expect(renderPrompt("hello {{nope}}", CONTEXT)).toBe("hello {{nope}}");
  });

  it("does not recursively expand substituted text", () => {
    const context = { ...CONTEXT, message: "{{author}}" };
    expect(renderPrompt("{{message}}", context)).toBe("{{author}}");
  });
});

describe("default prompts", () => {
  it("defines every key", () => {
    expect(Object.keys(DEFAULT_PROMPTS).sort()).toEqual([...PROMPT_KEYS].sort());
  });

  it("renders each default with no leftover tokens", () => {
    for (const key of PROMPT_KEYS) {
      const rendered = renderPrompt(DEFAULT_PROMPTS[key].template, CONTEXT);
      expect(rendered, `${key} left a token unrendered`).not.toMatch(/\{\{\s*[a-zA-Z]+\s*\}\}/);
    }
  });

  it("puts what was typed into the Ask box ahead of the closing instruction", () => {
    const question = "\n## My question\nwhy does this only happen on Safari?\n";
    const rendered = renderPrompt(DEFAULT_PROMPTS.ask.template, { ...CONTEXT, question });
    expect(rendered).toContain("## My question\nwhy does this only happen on Safari?");
    expect(rendered.indexOf("My question")).toBeLessThan(rendered.indexOf("Read this and the code"));
    // With nothing typed there is no empty heading, just the message.
    expect(renderPrompt(DEFAULT_PROMPTS.ask.template, CONTEXT)).not.toContain("My question");
  });

  it("replies in plain words, with no emoji and no leftover tokens", () => {
    for (const key of PROMPT_KEYS) {
      const reply = renderPrompt(DEFAULT_PROMPTS[key].reply, CONTEXT);
      expect(reply, `${key} left a token unrendered`).not.toMatch(/\{\{\s*[a-zA-Z]+\s*\}\}/);
      expect(reply, `${key} has an emoji`).not.toMatch(/:[a-z0-9_+-]+:|\p{Extended_Pictographic}/u);
    }
    expect(renderPrompt(DEFAULT_PROMPTS.linear.reply, CONTEXT)).toBe("Picking up DATA-3051.");
    expect(renderPrompt(DEFAULT_PROMPTS.github.reply, { ...CONTEXT, ticketId: "acme/web#123" })).toBe(
      "Picking up acme/web#123.",
    );
    expect(renderPrompt(DEFAULT_PROMPTS.jira.reply, { ...CONTEXT, ticketId: "ABC-123" })).toBe("Picking up ABC-123.");
  });

  it("tells the agent how to close a GitHub issue and link a Jira ticket from the commit", () => {
    const github = renderPrompt(DEFAULT_PROMPTS.github.template, {
      ...CONTEXT,
      ticket: "https://github.com/acme/web/issues/123",
      ticketId: "acme/web#123",
    });
    expect(github).toContain("acme/web#123: https://github.com/acme/web/issues/123");
    expect(github).toContain("gh issue view https://github.com/acme/web/issues/123 --comments");
    expect(github).toContain('"Fixes acme/web#123"');

    const jira = renderPrompt(DEFAULT_PROMPTS.jira.template, {
      ...CONTEXT,
      ticket: "https://acme.atlassian.net/browse/ABC-123",
      ticketId: "ABC-123",
    });
    expect(jira).toContain("ABC-123: https://acme.atlassian.net/browse/ABC-123");
    expect(jira).toContain("with ABC-123 at the start of the message");
    for (const rendered of [github, jira]) expect(rendered).not.toMatch(/\{\{\s*[a-zA-Z]+\s*\}\}/);
  });

  it("says in the Ask reply what you are looking into", () => {
    const reply = (question: string) => renderReply(DEFAULT_PROMPTS.ask.reply, CONTEXT, "web", question);
    expect(reply("  why does this only happen on Safari?\n")).toBe(
      "Looking into this: why does this only happen on Safari?",
    );
    // Typed text posts as typed, not as Slack markup.
    expect(reply("is <!channel> & <@U1> safe?")).toBe("Looking into this: is &lt;!channel&gt; &amp; &lt;@U1&gt; safe?");
    // With nothing typed there is no dangling colon.
    expect(reply("")).toBe("Looking into this.");
    expect(renderReply("On it in {{repo}}.", CONTEXT, "web", "")).toBe("On it in web.");
  });

  it("uses branch prefixes that are valid git ref fragments", () => {
    for (const key of PROMPT_KEYS) {
      expect(DEFAULT_PROMPTS[key].branchPrefix).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe("shellQuote", () => {
  it("wraps a plain value", () => {
    expect(shellQuote("claude")).toBe("'claude'");
  });

  it("neutralises embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps command substitution inert", () => {
    const quoted = shellQuote("$(rm -rf /)");
    expect(quoted).toBe("'$(rm -rf /)'");
  });

  it("survives a quote-escape breakout attempt", () => {
    // A naive implementation would let this close the quote and run `whoami`.
    const quoted = shellQuote("'; whoami; '");
    expect(quoted).toBe(`''\\''; whoami; '\\'''`);
  });
});

describe("tomlString", () => {
  it("quotes a plain value", () => {
    expect(tomlString("hello")).toBe('"hello"');
  });

  it("escapes backslashes and quotes", () => {
    expect(tomlString('C:\\path\\"x"')).toBe('"C:\\\\path\\\\\\"x\\""');
  });

  it("escapes newlines and control characters", () => {
    expect(tomlString("a\nb")).toBe('"a\\nb"');
    expect(tomlString("a\u0001b")).toBe('"a\\u0001b"');
  });
});
