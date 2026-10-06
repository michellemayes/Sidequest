/**
 * A follow-up on a session, from Slack.
 *
 * Agents rarely get it right in one go: the reporter replies "still broken
 * in Safari", or you read the answer and want one more thing. Rather than
 * cut a new branch from scratch, a follow-up goes to the session that is
 * already on it: its worktree, its branch and, where the agent can carry a
 * conversation on with a new prompt, its conversation. Otherwise the agent
 * starts afresh in the worktree, told where the earlier work is.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, PostResults } from "../config/schema.js";
import { agentConfigFor, MAX_LINK_PROMPT_CHARS, resolveAgent } from "../agents/agents.js";
import { headlessPaths } from "../terminals/headless.js";
import { armFollowUp, autorunPaths, FOLLOWUP_FILE, SESSION_DIR } from "../warp/autorun.js";
import { openUri } from "../util/openUri.js";
import { UserFacingError } from "../util/errors.js";
import { openSession, type FoundSession, type ReopenResult } from "./reopen.js";
import { resultInstructions } from "./result.js";

export interface FollowUp {
  /** What you typed. */
  text: string;
  /** Thread messages after the session's message, oldest first. */
  thread: Array<{ author: string; text: string }>;
  channel: string;
}

/** The follow-up as the agent reads it. */
export function renderFollowUp(followUp: FollowUp, postResults: PostResults): string {
  const lines = [`# Follow-up from Slack${followUp.channel ? ` (#${followUp.channel})` : ""}`, ""];
  if (followUp.text.trim()) lines.push(followUp.text.trim(), "");
  if (followUp.thread.length > 0) {
    lines.push("## The thread since", "");
    for (const message of followUp.thread) lines.push(`@${message.author}: ${message.text}`);
    lines.push("");
  }
  lines.push(
    `This carries on earlier work in this worktree: the original task is in \`${SESSION_DIR}/prompt.md\`, ` +
      "what was done so far is on this branch (`git log`), and your last reply, if any, is in " +
      `\`${SESSION_DIR}/result.md\`. Pick up from there.`,
  );
  return lines.join("\n").trimEnd() + resultInstructions(postResults);
}

/**
 * Hand a follow-up to a session's agent: in a terminal (or the background)
 * through the session's own script, or as a new session in the agent's
 * desktop app, which cannot reach back into the earlier one.
 */
export async function followUpSession(
  config: Config,
  found: FoundSession,
  agentId: string,
  followUp: FollowUp,
): Promise<ReopenResult> {
  if (!followUp.text.trim() && followUp.thread.length === 0) {
    throw new UserFacingError("There is nothing to follow up with.", "Type what you want the agent to do next.");
  }
  const prompt = renderFollowUp(followUp, config.settings.postResults);
  const worktree = found.worktree.path;
  const agent = resolveAgent(agentConfigFor(config.settings.agent, agentId));

  if (agent.app) {
    const composer = prompt.length > MAX_LINK_PROMPT_CHARS
      ? `Read ${SESSION_DIR}/${FOLLOWUP_FILE} in this folder and do what it asks. It follows up on earlier work here.`
      : prompt;
    await armFollowUpFile(worktree, prompt);
    await openUri(agent.app.newSessionUri(worktree, composer), agent.host, `Is ${agent.host} installed?`);
    return { host: agent.host, strategy: agent.id, agentStarted: null };
  }

  const script = config.settings.terminal === "headless"
    ? headlessPaths(worktree).scriptFile
    : autorunPaths(worktree).scriptFile;
  await armFollowUp(worktree, script, prompt);
  return openSession(config, found, agentId, { followUp: true });
}

/** An app session has no script to arm; the file is still where the composer points. */
async function armFollowUpFile(worktree: string, prompt: string): Promise<void> {
  await mkdir(join(worktree, SESSION_DIR), { recursive: true });
  await writeFile(join(worktree, SESSION_DIR, FOLLOWUP_FILE), `${prompt}\n`, "utf8");
}
