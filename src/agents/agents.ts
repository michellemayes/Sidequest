/**
 * The coding agents Sidequest can launch in a Warp tab.
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
  };
}
