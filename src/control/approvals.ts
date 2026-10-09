/**
 * Questions from a headless agent, answered in the Mac app.
 *
 * Claude Code run with --permission-prompt-tool asks an MCP tool before
 * anything its permission mode does not already allow. That tool is
 * `sidequest mcp-approve`, which hands the question to the daemon here; the
 * daemon shows it in the app, and the answer goes back the same way. With no
 * app open to ask, the answer is no, which is what the run's limits would
 * have said anyway.
 */
import { randomUUID } from "node:crypto";
import { summarizeTool } from "../session/transcript.js";

export interface Approval {
  id: string;
  branch: string;
  worktreePath: string;
  /** The session's title, so the question can say which session is asking. */
  title: string;
  tool: string;
  /** For a shell tool, "always" covers this exact command only. */
  perCommand: boolean;
  /** The command, file or URL, in one line. */
  summary: string;
  input: unknown;
  askedAt: string;
}

/** What Claude Code's permission prompt tool answers, as JSON text. */
export type Decision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

/** Tools whose every use is a different command: "always" means this command, not the tool. */
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "PowerShell"]);

/** What "always allow" remembers: the tool, or for a shell, the tool and its exact command. */
export function alwaysKey(tool: string, input: unknown): string {
  if (!COMMAND_TOOLS.has(tool)) return tool;
  const command = (input as { command?: unknown } | null)?.command;
  return `${tool}\0${typeof command === "string" ? command.trim() : ""}`;
}

/** A question nobody answers in this long is refused, so the run moves on. */
const ANSWER_TIMEOUT_MS = 15 * 60 * 1000;

export class Approvals {
  private readonly waiting = new Map<string, { approval: Approval; resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  /** What you said to always allow (see alwaysKey), per worktree, for as long as the daemon runs. */
  private readonly always = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      /** Whether someone (the Mac app) is there to ask. */
      canAsk: () => boolean;
      /** A new question, or one settled (with its id), for the app to show or drop. */
      onChange: (change: { asked?: Approval; settled?: string }) => void;
      timeoutMs?: number;
    },
  ) {}

  request(question: { branch: string; worktreePath: string; title: string; tool: string; input: unknown }): Promise<Decision> {
    if (this.always.get(question.worktreePath)?.has(alwaysKey(question.tool, question.input))) {
      return Promise.resolve({ behavior: "allow", updatedInput: question.input });
    }
    if (!this.options.canAsk()) {
      return Promise.resolve({
        behavior: "deny",
        message: "The Sidequest app isn't open to ask, so this isn't allowed. Carry on without it, or say what you need in your reply.",
      });
    }
    const approval: Approval = {
      id: randomUUID(),
      ...question,
      summary: summarizeTool(question.tool, question.input),
      perCommand: COMMAND_TOOLS.has(question.tool),
      askedAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(approval.id, { behavior: "deny", message: "Nobody answered in time, so this isn't allowed." });
      }, this.options.timeoutMs ?? ANSWER_TIMEOUT_MS);
      this.waiting.set(approval.id, { approval, resolve, timer });
      this.options.onChange({ asked: approval });
    });
  }

  /**
   * Your answer. `always` allows the same again for the rest of the session's
   * runs: this tool, or for a shell this exact command. False when the question is gone.
   */
  decide(id: string, allow: boolean, always = false): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    if (allow && always) {
      const tools = this.always.get(entry.approval.worktreePath) ?? new Set<string>();
      tools.add(alwaysKey(entry.approval.tool, entry.approval.input));
      this.always.set(entry.approval.worktreePath, tools);
    }
    this.settle(id, allow
      ? { behavior: "allow", updatedInput: entry.approval.input }
      : { behavior: "deny", message: "You said no to this. Carry on without it." });
    return true;
  }

  /** Questions still waiting, oldest first, for an app that has just connected. */
  get pending(): Approval[] {
    return [...this.waiting.values()].map((w) => w.approval);
  }

  private settle(id: string, decision: Decision): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    entry.resolve(decision);
    this.options.onChange({ settled: id });
  }
}
