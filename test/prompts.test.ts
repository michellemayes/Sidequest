import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS, renderPrompt, type PromptContext } from "../src/config/prompts.js";
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
  worktree: "/Users/m/.ccslack/worktrees/fix-checkout",
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
        "/Users/m/.ccslack/worktrees/fix-checkout|2026-09-09T14:32:00.000Z",
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
  it("defines all three keys", () => {
    expect(Object.keys(DEFAULT_PROMPTS).sort()).toEqual([...PROMPT_KEYS].sort());
  });

  it("renders each default with no leftover tokens", () => {
    for (const key of PROMPT_KEYS) {
      const rendered = renderPrompt(DEFAULT_PROMPTS[key].template, CONTEXT);
      expect(rendered, `${key} left a token unrendered`).not.toMatch(/\{\{\s*[a-zA-Z]+\s*\}\}/);
    }
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
