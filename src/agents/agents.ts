/**
 * The coding agents Sidequest can launch.
 *
 * Most run in a terminal (Warp unless settings.terminal names another, or
 * headless): it opens in the fresh worktree and runs
 * `<command> [...args] [...promptArgs]`. For most agents `promptArgs` is just
 * the rendered prompt as one trailing argument; agents that take it behind a
 * flag (`gemini --prompt-interactive`, `opencode --prompt`) or from a file say
 * so here. An agent whose CLI can't be driven this way can still be used by
 * pointing `command` at a small wrapper script.
 *
 * The rest are desktop apps, opened with a deep link instead of a terminal,
 * whatever settings.terminal says: the app
 * starts a new session in the worktree with the prompt in its composer, ready
 * for you to send.
 */

/** Stands in for the rendered prompt text in `promptArgs`. */
export const PROMPT_TOKEN = "{prompt}";
/** Stands in for the path to `.sidequest/prompt.md` in `promptArgs`. */
export const PROMPT_FILE_TOKEN = "{promptFile}";

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
  /**
   * How the prompt is handed over, after the args. `{prompt}` becomes the
   * prompt text and `{promptFile}` the path to `.sidequest/prompt.md`.
   * Defaults to `["{prompt}"]`, a trailing positional argument.
   */
  promptArgs?: string[];
  /**
   * For CLIs that only take a first message one-shot: once that run exits,
   * start the agent again with these args (after the user's) to carry on the
   * same conversation interactively.
   */
  resumeArgs?: string[];
  /**
   * How to pick up the worktree's latest conversation when a session that
   * has already run is opened again. Placed straight after the command (some
   * are subcommands), before the user's args. Absent when the CLI can't.
   */
  continueArgs?: string[];
  /**
   * Whether `continueArgs` can be followed by a new prompt (`claude
   * --continue "…"`), which is how a follow-up from Slack carries on the
   * conversation. Otherwise a follow-up starts the agent afresh on it.
   */
  continueWithPrompt?: boolean;
  /** Shown by `sidequest doctor` when the agent is not usable. */
  installHint: string;
  /**
   * How to run the agent with no terminal (settings.terminal "headless"),
   * or absent when it has no non-interactive mode.
   */
  headless?: HeadlessInvocation;
  /** Set for an agent that lives in a desktop app rather than a terminal. */
  app?: DesktopApp;
}

/**
 * A non-interactive run: `<command> [...args] [...user args] [...promptArgs]`
 * in the worktree, with nobody there to approve anything. The flags keep what
 * the agent may do to the worktree, since the prompt carries Slack text.
 */
export interface HeadlessInvocation {
  /** Placed before the user's own args and the prompt. */
  args: string[];
  /** Placed after `args` on a follow-up, to carry on the last run's conversation. */
  continueArgs?: string[];
  /** How the prompt is handed over, as for an agent's own `promptArgs`. Defaults to `["{prompt}"]`. */
  promptArgs?: string[];
  /**
   * Where the final answer comes out. `stdout`: the agent prints only its
   * answer, and the runner saves it to .sidequest/result.md. `file`: `args`
   * already make the agent write .sidequest/result.md itself, and all of its
   * output is progress for the log.
   */
  result: "stdout" | "file";
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
    continueArgs: ["--continue"],
    continueWithPrompt: true,
    // Print mode answers on stdout. acceptEdits lets it change files in the
    // worktree; anything else it would need a person to approve is refused.
    headless: { args: ["-p", "--permission-mode", "acceptEdits"], continueArgs: ["--continue"], result: "stdout" },
    installHint:
      "Install Claude Code (https://claude.com/claude-code), or point settings.agent.command at its executable.",
  },
  {
    id: "codex",
    label: "Codex",
    host: "Warp",
    command: "codex",
    defaultArgs: [],
    continueArgs: ["resume", "--last"],
    continueWithPrompt: true,
    // exec streams progress on stdout; --full-auto is its workspace-write
    // sandbox, and the last message is the answer.
    headless: {
      args: ["exec", "--full-auto", "--output-last-message", ".sidequest/result.md"],
      result: "file",
    },
    installHint:
      "Install the Codex CLI (npm install -g @openai/codex), or point settings.agent.command at its executable.",
  },
  {
    // Runs the prompt and stays interactive; -p would exit after one turn.
    id: "gemini",
    label: "Gemini CLI",
    host: "Warp",
    command: "gemini",
    defaultArgs: [],
    continueArgs: ["--resume", "latest"],
    continueWithPrompt: true,
    promptArgs: ["--prompt-interactive", PROMPT_TOKEN],
    // -p answers once on stdout; without approval, tools that change things are off.
    headless: { args: [], promptArgs: ["-p", PROMPT_TOKEN], result: "stdout" },
    installHint:
      "Install Gemini CLI (npm install -g @google/gemini-cli), or point settings.agent.command at its executable.",
  },
  {
    // Aider has no "first message, then chat" flag: its positional args are
    // files to edit, and --message-file answers once and exits. So the first
    // run sends the prompt, and a second one reopens that chat to carry on.
    id: "aider",
    label: "Aider",
    host: "Warp",
    command: "aider",
    defaultArgs: [],
    continueArgs: ["--restore-chat-history"],
    // A follow-up restores the chat and sends the follow-up into it.
    continueWithPrompt: true,
    promptArgs: ["--message-file", PROMPT_FILE_TOKEN],
    resumeArgs: ["--restore-chat-history"],
    installHint:
      "Install Aider (python -m pip install aider-install && aider-install), or point settings.agent.command at its executable.",
  },
  {
    // The installer links both `agent` and `cursor-agent`; the longer name
    // can't be mistaken for anything else on PATH.
    id: "cursor-agent",
    label: "Cursor Agent",
    host: "Warp",
    command: "cursor-agent",
    defaultArgs: [],
    continueArgs: ["resume"],
    // Print mode answers once on stdout; without --force it changes nothing.
    headless: { args: [], promptArgs: ["-p", PROMPT_TOKEN], result: "stdout" },
    installHint:
      "Install the Cursor CLI (curl https://cursor.com/install -fsS | bash), or point settings.agent.command at its executable.",
  },
  {
    // A positional arg to the opencode TUI is a project path, not a prompt.
    id: "opencode",
    label: "opencode",
    host: "Warp",
    command: "opencode",
    defaultArgs: [],
    continueArgs: ["--continue"],
    promptArgs: ["--prompt", PROMPT_TOKEN],
    installHint:
      "Install opencode (npm install -g opencode-ai), or point settings.agent.command at its executable.",
  },
  {
    // Runs the prompt as the first turn of a normal session; -p is one-shot.
    id: "copilot",
    label: "Copilot CLI",
    host: "Warp",
    command: "copilot",
    defaultArgs: [],
    continueArgs: ["--continue"],
    promptArgs: ["--interactive", PROMPT_TOKEN],
    installHint:
      "Install GitHub Copilot CLI (npm install -g @github/copilot), or point settings.agent.command at its executable.",
  },
  {
    // A fork of Gemini CLI, with the same flag.
    id: "qwen",
    label: "Qwen Code",
    host: "Warp",
    command: "qwen",
    defaultArgs: [],
    continueArgs: ["--continue"],
    promptArgs: ["--prompt-interactive", PROMPT_TOKEN],
    // Same as Gemini CLI, which it forks.
    headless: { args: [], promptArgs: ["-p", PROMPT_TOKEN], result: "stdout" },
    installHint:
      "Install Qwen Code (npm install -g @qwen-code/qwen-code), or point settings.agent.command at its executable.",
  },
  {
    // `goose run` works through the instructions file; --interactive then
    // keeps the session open instead of exiting.
    id: "goose",
    label: "Goose",
    host: "Warp",
    command: "goose",
    defaultArgs: [],
    continueArgs: ["session", "--resume"],
    promptArgs: ["run", "--interactive", "--instructions", PROMPT_FILE_TOKEN],
    installHint:
      "Install the Goose CLI (brew install block-goose-cli), or point settings.agent.command at its executable.",
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
  promptArgs: string[];
  resumeArgs?: string[];
  continueArgs?: string[];
  continueWithPrompt?: boolean;
  /** The agent's non-interactive mode, if it has one. */
  headless?: HeadlessInvocation;
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
    promptArgs: def.promptArgs ?? [PROMPT_TOKEN],
    ...(def.resumeArgs ? { resumeArgs: def.resumeArgs } : {}),
    ...(def.continueArgs ? { continueArgs: def.continueArgs } : {}),
    ...(def.continueWithPrompt ? { continueWithPrompt: true } : {}),
    ...(def.headless ? { headless: def.headless } : {}),
    ...(def.app ? { app: def.app } : {}),
  };
}

/**
 * The agent config a session runs with: settings.agent, unless its prompt
 * names another agent, which then runs with that agent's own defaults —
 * settings.agent's command and args are for settings.agent's CLI.
 */
export function agentConfigFor(settingsAgent: AgentConfig, agentId = ""): AgentConfig {
  const id = agentId.trim();
  if (!id || id === settingsAgent.id) return settingsAgent;
  return { id, command: "", args: [] };
}

/**
 * The args after the command for a follow-up in a terminal: the conversation
 * carried on with the follow-up as its next prompt where the CLI can do
 * that, else a fresh run on it (the follow-up says where the earlier work is).
 */
export function followUpArgs(
  agent: Pick<ResolvedAgent, "args" | "promptArgs" | "continueArgs" | "continueWithPrompt">,
): string[] {
  const carryOn = agent.continueWithPrompt && agent.continueArgs ? agent.continueArgs : [];
  return [...carryOn, ...agent.args, ...agent.promptArgs];
}

/** Swap the prompt placeholders in one arg for real values. */
export function fillPromptArg(arg: string, prompt: string, promptFile: string): string {
  return arg
    .split(PROMPT_TOKEN)
    .map((part) => part.split(PROMPT_FILE_TOKEN).join(promptFile))
    .join(prompt);
}

/**
 * The argv a terminal agent's first run gets. Left at their defaults, the
 * prompt shows as `<prompt>` and the file as its path in the worktree, which
 * is what the CLI prints.
 */
export function agentArgv(
  agent: Pick<ResolvedAgent, "command" | "args" | "promptArgs">,
  prompt = "<prompt>",
  promptFile = ".sidequest/prompt.md",
): string[] {
  return [agent.command, ...agent.args, ...agent.promptArgs.map((arg) => fillPromptArg(arg, prompt, promptFile))];
}

/**
 * How `status` and `agents` describe an agent: the command line it runs (and
 * its second run, for a one-shot CLI), or the link its app opens.
 */
export function describeAgent(
  agent: Pick<ResolvedAgent, "host" | "command" | "args" | "promptArgs" | "resumeArgs" | "app">,
): string {
  if (agent.app) {
    const link = agent.app.newSessionUri("").split("?")[0];
    return `opens ${link} in ${agent.host}`;
  }
  const first = agentArgv(agent).join(" ");
  if (!agent.resumeArgs) return first;
  return `${first}, then ${[agent.command, ...agent.args, ...agent.resumeArgs].join(" ")}`;
}

/** The command line a headless run uses, or "" for an agent with no headless mode. */
export function describeHeadless(agent: Pick<ResolvedAgent, "command" | "args" | "headless">): string {
  if (!agent.headless) return "";
  return agentArgv({
    command: agent.command,
    args: [...agent.headless.args, ...agent.args],
    promptArgs: agent.headless.promptArgs ?? [PROMPT_TOKEN],
  }).join(" ");
}
