/**
 * The coding agents Sidequest can launch.
 *
 * Most run in a Warp tab: a terminal opens in the fresh worktree and runs
 * `<command> [...args] "<prompt>"`, with the rendered prompt as one trailing
 * argument. An agent whose CLI takes the prompt differently (a flag, stdin)
 * can still be used by pointing `command` at a small wrapper script.
 *
 * The rest are desktop apps, opened with a deep link instead of Warp: the app
 * starts a new session in the worktree with the prompt in its composer, ready
 * for you to send.
 */

export interface DesktopApp {
  /** macOS app names that can handle the link, checked by `sidequest doctor`. */
  appNames: string[];
  /**
   * The deep link for a new session in `folder`, with `prompt` in the
   * composer when there is one.
   */
  newSessionUri(folder: string, prompt?: string): string;
}

export interface AgentDefinition {
  /** Stable id used in config.json, e.g. "codex". */
  id: string;
  /** Human label, shown in the overlay and CLI output. */
  label: string;
  /** Where sessions open, e.g. "Warp" or "the Claude app". */
  host: string;
  /** Default executable; empty for a desktop app. */
  command: string;
  /** Default extra args placed before the prompt. */
  defaultArgs: string[];
  /** Shown by `sidequest doctor` when the agent is not usable. */
  installHint: string;
  /** Set for an agent that lives in a desktop app rather than a terminal. */
  app?: DesktopApp;
}

/**
 * The apps cap how much text a link can prefill (Claude truncates `q` at about
 * 14,000 characters). A longer prompt is left in the worktree for the agent
 * to read rather than cut off mid-report.
 */
export const MAX_LINK_PROMPT_CHARS = 12_000;

/** What goes in the composer when the prompt is too long for the link. */
export const PROMPT_FILE_POINTER =
  "Read .sidequest/prompt.md in this folder and do what it asks. It is the task, taken from a Slack message.";

/** The prompt as a link can carry it: whole, or a pointer to the prompt file. */
export function linkPrompt(prompt: string): string {
  return prompt.length > MAX_LINK_PROMPT_CHARS ? PROMPT_FILE_POINTER : prompt;
}

function query(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    host: "Warp",
    command: "claude",
    defaultArgs: [],
    installHint:
      "Install Claude Code (https://claude.com/claude-code), or point settings.agent.command at its executable.",
  },
  {
    id: "codex",
    label: "Codex",
    host: "Warp",
    command: "codex",
    defaultArgs: [],
    installHint:
      "Install the Codex CLI (npm install -g @openai/codex), or point settings.agent.command at its executable.",
  },
  {
    id: "claude-desktop",
    label: "Claude Code",
    host: "the Claude app",
    command: "",
    defaultArgs: [],
    installHint: "Install the Claude desktop app (https://claude.com/download) and sign in.",
    app: {
      appNames: ["Claude"],
      // https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
      newSessionUri: (folder, prompt) => `claude://code/new?${query({ q: prompt, folder })}`,
    },
  },
  {
    id: "chatgpt",
    label: "Codex",
    host: "the ChatGPT app",
    command: "",
    defaultArgs: [],
    installHint: "Install the ChatGPT desktop app (https://chatgpt.com/download) and sign in.",
    app: {
      // The ChatGPT app took over the Codex app's codex:// links; either handles them.
      appNames: ["ChatGPT", "Codex"],
      // https://learn.chatgpt.com/docs/reference/commands
      newSessionUri: (folder, prompt) => `codex://threads/new?${query({ prompt, path: folder })}`,
    },
  },
];

/** Look up a built-in agent by id; unknown ids fall back to the first one. */
export function agentDefinition(id: string): AgentDefinition {
  return AGENT_DEFINITIONS.find((d) => d.id === id) ?? AGENT_DEFINITIONS[0]!;
}

export interface AgentConfig {
  id: string;
  command: string;
  args: string[];
}

export interface ResolvedAgent {
  id: string;
  label: string;
  host: string;
  command: string;
  args: string[];
  app?: DesktopApp;
}

/**
 * Merge a built-in agent definition with the user's overrides from config.
 * An empty command means "the agent's default"; empty args likewise.
 */
export function resolveAgent(config: AgentConfig): ResolvedAgent {
  const def = agentDefinition(config.id);
  return {
    id: def.id,
    label: def.label,
    host: def.host,
    command: config.command.trim() || def.command,
    args: config.args.length > 0 ? config.args : def.defaultArgs,
    ...(def.app ? { app: def.app } : {}),
  };
}

/** How `status` and `agents` describe an agent: its command line, or its app. */
export function describeAgent(agent: { host: string; command: string; args: string[]; app?: DesktopApp }): string {
  return agent.app ? `opens in ${agent.host}` : [agent.command, ...agent.args].join(" ");
}
