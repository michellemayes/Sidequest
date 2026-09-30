/**
 * The coding agents Sidequest can launch in a Warp tab.
 *
 * A terminal opens in the fresh worktree and runs
 * `<command> [...args] [...promptArgs]`. For most agents `promptArgs` is just
 * the rendered prompt as one trailing argument; agents that take it behind a
 * flag (`gemini --prompt-interactive`, `opencode --prompt`) or from a file say
 * so here. An agent whose CLI can't be driven this way can still be used by
 * pointing `command` at a small wrapper script.
 */

/** Stands in for the rendered prompt text in `promptArgs`. */
export const PROMPT_TOKEN = "{prompt}";
/** Stands in for the path to `.sidequest/prompt.md` in `promptArgs`. */
export const PROMPT_FILE_TOKEN = "{promptFile}";

export interface AgentDefinition {
  /** Stable id used in config.json, e.g. "codex". */
  id: string;
  /** Human label, shown in the overlay and CLI output. */
  label: string;
  /** Default executable. */
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
  /** Shown by `sidequest doctor` when the command is not usable. */
  installHint: string;
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    defaultArgs: [],
    installHint:
      "Install Claude Code (https://claude.com/claude-code), or point settings.agent.command at its executable.",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    defaultArgs: [],
    installHint:
      "Install the Codex CLI (npm install -g @openai/codex), or point settings.agent.command at its executable.",
  },
  {
    // Runs the prompt and stays interactive; -p would exit after one turn.
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    defaultArgs: [],
    promptArgs: ["--prompt-interactive", PROMPT_TOKEN],
    installHint:
      "Install Gemini CLI (npm install -g @google/gemini-cli), or point settings.agent.command at its executable.",
  },
  {
    // Aider has no "first message, then chat" flag: its positional args are
    // files to edit, and --message-file answers once and exits. So the first
    // run sends the prompt, and a second one reopens that chat to carry on.
    id: "aider",
    label: "Aider",
    command: "aider",
    defaultArgs: [],
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
    command: "cursor-agent",
    defaultArgs: [],
    installHint:
      "Install the Cursor CLI (curl https://cursor.com/install -fsS | bash), or point settings.agent.command at its executable.",
  },
  {
    // A positional arg to the opencode TUI is a project path, not a prompt.
    id: "opencode",
    label: "opencode",
    command: "opencode",
    defaultArgs: [],
    promptArgs: ["--prompt", PROMPT_TOKEN],
    installHint:
      "Install opencode (npm install -g opencode-ai), or point settings.agent.command at its executable.",
  },
  {
    // Runs the prompt as the first turn of a normal session; -p is one-shot.
    id: "copilot",
    label: "Copilot CLI",
    command: "copilot",
    defaultArgs: [],
    promptArgs: ["--interactive", PROMPT_TOKEN],
    installHint:
      "Install GitHub Copilot CLI (npm install -g @github/copilot), or point settings.agent.command at its executable.",
  },
  {
    // A fork of Gemini CLI, with the same flag.
    id: "qwen",
    label: "Qwen Code",
    command: "qwen",
    defaultArgs: [],
    promptArgs: ["--prompt-interactive", PROMPT_TOKEN],
    installHint:
      "Install Qwen Code (npm install -g @qwen-code/qwen-code), or point settings.agent.command at its executable.",
  },
  {
    // `goose run` works through the instructions file; --interactive then
    // keeps the session open instead of exiting.
    id: "goose",
    label: "Goose",
    command: "goose",
    defaultArgs: [],
    promptArgs: ["run", "--interactive", "--instructions", PROMPT_FILE_TOKEN],
    installHint:
      "Install the Goose CLI (brew install block-goose-cli), or point settings.agent.command at its executable.",
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
  command: string;
  args: string[];
  promptArgs: string[];
  resumeArgs?: string[];
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
    command: config.command.trim() || def.command,
    args: config.args.length > 0 ? config.args : def.defaultArgs,
    promptArgs: def.promptArgs ?? [PROMPT_TOKEN],
    ...(def.resumeArgs ? { resumeArgs: def.resumeArgs } : {}),
  };
}

/** Swap the prompt placeholders in one arg for real values. */
export function fillPromptArg(arg: string, prompt: string, promptFile: string): string {
  return arg
    .split(PROMPT_TOKEN)
    .map((part) => part.split(PROMPT_FILE_TOKEN).join(promptFile))
    .join(prompt);
}

/**
 * The argv an agent's first run gets. Left at their defaults, the prompt shows
 * as `<prompt>` and the file as its path in the worktree, which is what the
 * CLI prints.
 */
export function agentArgv(
  agent: Pick<ResolvedAgent, "command" | "args" | "promptArgs">,
  prompt = "<prompt>",
  promptFile = ".sidequest/prompt.md",
): string[] {
  return [agent.command, ...agent.args, ...agent.promptArgs.map((arg) => fillPromptArg(arg, prompt, promptFile))];
}

/** A one-line description of how an agent is launched, for CLI output. */
export function describeInvocation(agent: Pick<ResolvedAgent, "command" | "args" | "promptArgs" | "resumeArgs">): string {
  const first = agentArgv(agent).join(" ");
  if (!agent.resumeArgs) return first;
  return `${first}, then ${[agent.command, ...agent.args, ...agent.resumeArgs].join(" ")}`;
}
