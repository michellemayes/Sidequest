import type { PromptKey } from "./schema.js";

/**
 * Issue trackers a Slack message can link, each with its own prompt that only
 * shows up on a message linking one of its tickets. Adding a tracker is a
 * provider here, a prompt in DEFAULT_PROMPTS under the same key, and a line
 * in the overlay's TICKET_PATTERNS (client/inject.js), which mirrors these
 * patterns to decide what to offer; this side reads the link again on the way in.
 */
export interface Ticket {
  /** The prompt that works this kind of ticket. */
  provider: TicketPromptKey;
  /** The link, as {{ticket}}. */
  url: string;
  /**
   * How the tracker names the ticket, as {{ticketId}}: what goes in the
   * commit message so the tracker links it (DATA-3051, owner/repo#123, ABC-123).
   */
  id: string;
  /** What leads the branch name, so the tracker links the branch too. */
  branchKey: string;
  /** A title slug, when the link carries one; the branch uses it over the message. */
  slug: string;
}

export const TICKET_PROMPT_KEYS = ["linear", "github", "jira"] as const satisfies readonly PromptKey[];
export type TicketPromptKey = (typeof TICKET_PROMPT_KEYS)[number];

interface TicketProvider {
  /** Global, so every link in a string can be found in order. */
  pattern: RegExp;
  read(match: RegExpExecArray): Omit<Ticket, "provider">;
  /**
   * Keep the key's case in the branch name. Linear matches branches in any
   * case; Jira's development panel only reliably picks up an upper-case key.
   */
  keepBranchCase: boolean;
}

/** A Linear issue link, with the issue identifier (e.g. DATA-3051) captured. */
export const LINEAR_ISSUE =
  /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/([a-z0-9-]+))?[^\s<>|]*/i;

/**
 * A GitHub issue link: owner, repo and number. Only full links count; a bare
 * #123 could be any repo's, or not an issue at all.
 */
export const GITHUB_ISSUE =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/issues\/(\d+)(?![\d])/i;

/**
 * A Jira issue link: Jira Cloud's <site>.atlassian.net/browse/ABC-123, and a
 * self-hosted Jira's /browse/ABC-123 under whatever host and context path.
 */
export const JIRA_ISSUE =
  /https?:\/\/[^/\s<>|]+(?:\/[^/\s<>|?#]+)*?\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?![\w-])/i;

const global = (pattern: RegExp) => new RegExp(pattern.source, `${pattern.flags}g`);

const PROVIDERS: Record<TicketPromptKey, TicketProvider> = {
  linear: {
    pattern: global(LINEAR_ISSUE),
    read: (match) => ({
      url: match[0],
      id: match[1]!.toUpperCase(),
      branchKey: match[1]!.toUpperCase(),
      slug: match[2] ?? "",
    }),
    keepBranchCase: false,
  },
  github: {
    pattern: global(GITHUB_ISSUE),
    read: (match) => {
      const [, owner, repo, number] = match as unknown as [string, string, string, string];
      return {
        url: `https://github.com/${owner}/${repo}/issues/${number}`,
        // Qualified, so "Fixes owner/repo#123" closes it even from a fork or
        // another repo's branch.
        id: `${owner}/${repo}#${number}`,
        branchKey: number,
        slug: "",
      };
    },
    keepBranchCase: false,
  },
  jira: {
    pattern: global(JIRA_ISSUE),
    read: (match) => {
      const key = match[1]!.toUpperCase();
      // The link up to the key: a comment anchor or query adds nothing.
      const url = match[0].slice(0, match[0].length - match[1]!.length) + key;
      return { url, id: key, branchKey: key, slug: "" };
    },
    keepBranchCase: true,
  },
};

export function isTicketPrompt(key: string): key is TicketPromptKey {
  return (TICKET_PROMPT_KEYS as readonly string[]).includes(key);
}

/** Whether the branch keeps the ticket key's case; see TicketProvider. */
export function keepsBranchCase(key: TicketPromptKey): boolean {
  return PROVIDERS[key].keepBranchCase;
}

/** The first ticket of one tracker in a string. */
export function ticketFor(key: TicketPromptKey, text: string): Ticket | null {
  const { pattern, read } = PROVIDERS[key];
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match ? { provider: key, ...read(match) } : null;
}

/** Every ticket in a string, of any tracker, in the order they appear. */
export function ticketsIn(text: string): Ticket[] {
  const found: Array<{ index: number; ticket: Ticket }> = [];
  for (const key of TICKET_PROMPT_KEYS) {
    const { pattern, read } = PROVIDERS[key];
    for (const match of text.matchAll(pattern)) {
      found.push({ index: match.index ?? 0, ticket: { provider: key, ...read(match as RegExpExecArray) } });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.ticket);
}

/** The first ticket in a string, of any tracker. */
export function firstTicket(text: string): Ticket | null {
  return ticketsIn(text)[0] ?? null;
}
