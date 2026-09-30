import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS } from "../src/config/prompts.js";
import { PROMPT_KEYS } from "../src/config/schema.js";
import { firstTicket, ticketFor, ticketsIn, TICKET_PROMPT_KEYS } from "../src/config/tickets.js";

describe("Linear tickets", () => {
  it("reads the identifier and title slug off an issue link", () => {
    expect(
      ticketFor("linear", "see https://linear.app/pushnami/issue/DATA-3051/textnami-quiet-the-flapping for it"),
    ).toEqual({
      provider: "linear",
      url: "https://linear.app/pushnami/issue/DATA-3051/textnami-quiet-the-flapping",
      id: "DATA-3051",
      branchKey: "DATA-3051",
      slug: "textnami-quiet-the-flapping",
    });
  });

  it("takes a link with no slug, and upper-cases the identifier", () => {
    expect(ticketFor("linear", "<https://linear.app/acme/issue/eng-12|eng-12>")).toMatchObject({
      url: "https://linear.app/acme/issue/eng-12",
      id: "ENG-12",
      slug: "",
    });
  });

  it("ignores anything that is not a Linear issue", () => {
    expect(ticketFor("linear", "https://linear.app/acme/project/big-thing")).toBeNull();
    expect(ticketFor("linear", "https://example.com/issue/DATA-1")).toBeNull();
    expect(ticketFor("linear", "")).toBeNull();
  });
});

describe("GitHub issues", () => {
  it("names the issue with its repo, so the commit can close it from anywhere", () => {
    expect(ticketFor("github", "<https://github.com/acme/web-app/issues/123#issuecomment-9|this>")).toEqual({
      provider: "github",
      url: "https://github.com/acme/web-app/issues/123",
      id: "acme/web-app#123",
      branchKey: "123",
      slug: "",
    });
  });

  it("ignores pull requests, bare shorthands and other GitHub pages", () => {
    expect(ticketFor("github", "https://github.com/acme/web/pull/45")).toBeNull();
    expect(ticketFor("github", "fixed in #123")).toBeNull();
    expect(ticketFor("github", "https://github.com/acme/web/issues")).toBeNull();
    expect(ticketFor("github", "https://gitlab.com/acme/web/issues/3")).toBeNull();
  });
});

describe("Jira tickets", () => {
  it("reads the key off a Jira Cloud link, dropping anything after it", () => {
    expect(ticketFor("jira", "https://acme.atlassian.net/browse/abc-123?focusedCommentId=5")).toEqual({
      provider: "jira",
      url: "https://acme.atlassian.net/browse/ABC-123",
      id: "ABC-123",
      branchKey: "ABC-123",
      slug: "",
    });
  });

  it("reads a self-hosted Jira under a context path", () => {
    expect(ticketFor("jira", "https://jira.acme.io/jira/browse/OPS-7")).toMatchObject({
      url: "https://jira.acme.io/jira/browse/OPS-7",
      id: "OPS-7",
    });
  });

  it("ignores links that only look like a key", () => {
    expect(ticketFor("jira", "https://acme.atlassian.net/browse/ABC")).toBeNull();
    expect(ticketFor("jira", "https://acme.atlassian.net/browse/ABC-12x")).toBeNull();
    expect(ticketFor("jira", "ABC-123")).toBeNull();
  });
});

describe("tickets in a message", () => {
  it("lists every tracker's tickets in the order they appear", () => {
    const text =
      "dupe of https://acme.atlassian.net/browse/OPS-7, see https://github.com/acme/web/issues/9 " +
      "and https://linear.app/acme/issue/DATA-1";
    expect(ticketsIn(text).map((t) => `${t.provider}:${t.id}`)).toEqual([
      "jira:OPS-7",
      "github:acme/web#9",
      "linear:DATA-1",
    ]);
    expect(firstTicket(text)?.id).toBe("OPS-7");
    expect(firstTicket("nothing here")).toBeNull();
  });

  it("has a prompt, and a config key, for every tracker", () => {
    for (const key of TICKET_PROMPT_KEYS) {
      expect(PROMPT_KEYS).toContain(key);
      expect(DEFAULT_PROMPTS[key].template).toContain("{{ticketId}}");
    }
  });
});
