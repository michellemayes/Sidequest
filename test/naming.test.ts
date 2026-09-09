import { describe, expect, it } from "vitest";
import { branchNameFor, tabTitle, warpConfigName } from "../src/session/naming.js";
import { slugify, stripSlackMarkup, timeFragment } from "../src/util/slug.js";

const NOW = new Date("2026-09-09T14:32:00Z");

describe("slugify", () => {
  it("reduces text to a git-safe fragment", () => {
    expect(slugify("Login is Broken!! (again)")).toBe("login-is-broken-again");
  });

  it("strips accents rather than dropping the word", () => {
    expect(slugify("café crash")).toBe("cafe-crash");
  });

  it("never emits characters git check-ref-format rejects", () => {
    const slug = slugify("weird ~^:?*[\\ name..with @{ braces");
    expect(slug).toMatch(/^[a-z0-9-]*$/);
    expect(slug).not.toContain("..");
  });

  it("trims to a word boundary when one is near the limit", () => {
    const slug = slugify("alpha beta gamma delta epsilon zeta eta theta", 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("hard-cuts a single long word rather than returning nothing", () => {
    expect(slugify("a".repeat(60), 20)).toBe("a".repeat(20));
  });

  it("returns empty for text with no alphanumerics", () => {
    expect(slugify("!!! ??? ...")).toBe("");
  });
});

describe("stripSlackMarkup", () => {
  it("renders user mentions with their label", () => {
    expect(stripSlackMarkup("hey <@U123|michelle> look")).toBe("hey @michelle look");
  });

  it("falls back to the id when a mention has no label", () => {
    expect(stripSlackMarkup("hey <@U123>")).toBe("hey @U123");
  });

  it("keeps the label of a linked url", () => {
    expect(stripSlackMarkup("see <https://example.com|the docs>")).toBe("see the docs");
  });

  it("unwraps a bare url", () => {
    expect(stripSlackMarkup("see <https://example.com>")).toBe("see https://example.com");
  });

  it("renders channel links and broadcasts", () => {
    expect(stripSlackMarkup("<#C1|general> <!here>")).toBe("#general @here");
  });

  it("decodes html entities", () => {
    expect(stripSlackMarkup("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });
});

describe("timeFragment", () => {
  it("formats as yyyymmdd-hhmm using local time", () => {
    const local = new Date(2026, 8, 9, 14, 32);
    expect(timeFragment(local)).toBe("20260909-1432");
  });
});

describe("branchNameFor", () => {
  it("builds prefix/slug-date", () => {
    const branch = branchNameFor({
      promptKey: "fix",
      branchPrefix: "fix",
      messageText: "Checkout total is wrong for gift cards",
      messageTs: "1757430000.000100",
      now: new Date(2026, 8, 9, 14, 32),
    });
    expect(branch).toBe("fix/checkout-total-is-wrong-for-gift-cards-20260909-1432");
  });

  it("falls back to the timestamp when the message has no words", () => {
    const branch = branchNameFor({
      promptKey: "review",
      branchPrefix: "review",
      messageText: "\u{1F440} ???",
      messageTs: "1757430000.000100",
      now: new Date(2026, 8, 9, 14, 32),
    });
    expect(branch).toContain("msg-1757430000000100");
  });

  it("strips Slack markup before slugifying", () => {
    const branch = branchNameFor({
      promptKey: "investigate",
      branchPrefix: "investigate",
      messageText: "<@U1|ann> says <https://x.com|the api> is down",
      messageTs: "1757430000.000100",
      now: NOW,
    });
    expect(branch).toMatch(/^investigate\/ann-says-the-api-is-down-/);
  });
});

describe("warpConfigName", () => {
  it("produces a filename-safe, lowercase name", () => {
    expect(warpConfigName("fix/Total-Wrong-20260909-1432")).toBe(
      "ccslack-fix-total-wrong-20260909-1432",
    );
  });
});

describe("tabTitle", () => {
  it("joins the prompt and repo", () => {
    expect(tabTitle("Fix", "storefront")).toBe("Fix · storefront");
  });
});
