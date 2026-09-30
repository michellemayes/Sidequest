/**
 * The coding agents Sidequest can launch in a terminal.
 *
 * Every agent is driven the same way: a terminal opens in the fresh worktree
 * and runs `<command> [...args] "<prompt>"`, with the rendered prompt as one
 * trailing argument. An agent whose CLI takes the prompt differently (a flag,
 * stdin) can still be used by pointing `command` at a small wrapper script.
 */

export interface AgentDefinition {
  /** Stable id used in config.json, e.g. "codex". */
  id: string;
  /** Human label, shown in the overlay and CLI output. */
  label: string;
  /** Default executable. */
  command: string;
  /** Default extra args placed before the prompt. */
  defaultArgs: string[];
  /** Shown by `sidequest doctor` when the command is not usable. */
  installHint: string;
  /**
   * How to run the agent with no terminal (settings.terminal "headless"),
   * or absent when it has no non-interactive mode.
   */
  headless?: HeadlessInvocation;
}

/**
 * A non-interactive run: `<command> [...args] [...user args] "<prompt>"` in
 * the worktree, with nobody there to approve anything. The flags keep what
 * the agent may do to the worktree, since the prompt carries Slack text.
 */
export interface HeadlessInvocation {
  /** Placed before the user's own args and the prompt. */
  args: string[];
  /**
   * Where the final answer comes out. `stdout`: the agent prints only its
   * answer, and the runner saves it to .sidequest/result.md. `file`: `args`
   * already make the agent write .sidequest/result.md itself, and all of its
   * output is progress for the log.
   */
  result: "stdout" | "file";
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    defaultArgs: [],
    // Print mode answers on stdout. acceptEdits lets it change files in the
    // worktree; anything else it would need a person to approve is refused.
    headless: { args: ["-p", "--permission-mode", "acceptEdits"], result: "stdout" },
    installHint:
      "Install Claude Code (https://claude.com/claude-code), or point settings.agent.command at its executable.",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    defaultArgs: [],
    // exec streams progress on stdout; --full-auto is its workspace-write
    // sandbox, and the last message is the answer.
    headless: {
      args: ["exec", "--full-auto", "--output-last-message", ".sidequest/result.md"],
      result: "file",
    },
    installHint:
      "Install the Codex CLI (npm install -g @openai/codex), or point settings.agent.command at its executable.",
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
  /** The agent's non-interactive mode, if it has one. */
  headless?: HeadlessInvocation;
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
    ...(def.headless ? { headless: def.headless } : {}),
  };
}
