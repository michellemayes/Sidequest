import { loadConfig, promptFor } from "../config/store.js";
import { linksForChannel, repoForChannelName } from "../config/channels.js";
import { linearTicket, renderPrompt, type LinearTicket, type PromptContext } from "../config/prompts.js";
import { resolveAgent } from "../agents/agents.js";
import type { Config, PromptKey } from "../config/schema.js";
import { inspectRepo } from "../git/repo.js";
import { createWorktree } from "../git/worktree.js";
import { writeAutorun } from "../warp/autorun.js";
import { colorForPrompt, launchWarp } from "../warp/launcher.js";
import { branchNameFor, tabTitle, warpConfigName } from "./naming.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { stripSlackMarkup } from "../util/slug.js";
import { log } from "../util/log.js";

/** Everything the overlay could read off the message that was clicked. */
export interface MessageContext {
  channelName: string;
  authorName: string;
  text: string;
  ts: string;
  permalink: string;
  /** Surrounding thread replies, oldest first, already trimmed to the limit. */
  threadMessages: Array<{ author: string; text: string }>;
  /** Linear issue URL the message links; only the Linear prompt needs it. */
  ticket?: string;
  /** What the user typed into the Ask box, if anything. */
  question?: string;
  /** Which of the channel's repos to work in, by label or path; empty means its default. */
  repo?: string;
}

export interface SessionResult {
  branch: string;
  worktreePath: string;
  repoPath: string;
  repoLabel: string;
  baseBranch: string;
  promptLabel: string;
  agentLabel: string;
  launchStrategy: string;
  fellBackToNewTab: boolean;
  promptFile: string;
  /**
   * What to post in the message's thread, rendered; empty when
   * settings.autoReply is off or the prompt has no reply.
   */
  reply: string;
  /** Set when the worktree is ready but Warp could not be opened, or the agent did not start. */
  launchError?: string;
}

/**
 * The whole flow behind one button click: resolve the channel's repo, cut a
 * worktree, render the prompt into it, and open Warp there.
 */
export async function createSession(
  promptKey: PromptKey,
  message: MessageContext,
  configOverride?: Config,
): Promise<SessionResult> {
  const config = configOverride ?? (await loadConfig());
  const link = repoForChannelName(config, message.channelName, message.repo ?? "");

  if (!link) {
    if (linksForChannel(config, message.channelName).length > 0) {
      throw new UserFacingError(
        `${message.repo} is no longer linked to #${message.channelName}.`,
        "Pick one of the channel's other repos, or link it again.",
      );
    }
    throw new UserFacingError(
      `No repo is linked to #${message.channelName}.`,
      "Click the repo button in the channel header, or run `sidequest link <path> -c <channel>`.",
    );
  }

  // Checked before anything is cut: a Linear session with no ticket is
  // just a Fix with the wrong name.
  const ticket = linearTicket(message.ticket ?? "");
  if (promptKey === "linear" && !ticket) {
    throw new UserFacingError("That message has no Linear issue link to work from.");
  }

  const repo = await inspectRepo(link.repoPath);
  const baseBranch = link.baseBranch.trim() || repo.defaultBranch;
  const repoLabel = link.label.trim() || repo.name;
  const prompt = promptFor(config, promptKey);
  const agent = resolveAgent(config.settings.agent);

  const branch = branchNameFor({
    promptKey,
    branchPrefix: prompt.branchPrefix,
    // A Linear branch is named for the ticket, which Linear then links it to.
    messageText: promptKey === "linear" && ticket?.slug ? ticket.slug : message.text,
    messageTs: message.ts,
    ticketId: promptKey === "linear" ? ticket?.id : undefined,
  });

  const worktree = await createWorktree({
    repo,
    branch,
    baseBranch,
    worktreesRoot: config.settings.worktreesRoot,
    fetch: config.settings.fetchBeforeCreate,
  });

  const context = buildContext(message, {
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    repo: repo.root,
    worktree: worktree.path,
    threadLimit: config.settings.threadContextLimit,
    ticket,
  });
  const body = renderPrompt(prompt.template, context);
  // The repo in a reply is its label: a path on your machine means nothing in Slack.
  const reply = config.settings.autoReply
    ? renderPrompt(prompt.reply, { ...context, repo: repoLabel }).trim()
    : "";

  const files = await writeAutorun({
    worktreePath: worktree.path,
    prompt: body,
    agentCommand: agent.command,
    agentArgs: agent.args,
    agentLabel: agent.label,
  });

  const base = {
    branch: worktree.branch,
    worktreePath: worktree.path,
    repoPath: repo.root,
    repoLabel,
    baseBranch: worktree.baseBranch,
    promptLabel: prompt.label,
    promptFile: files.promptFile,
    agentLabel: agent.label,
    reply,
  };

  // The worktree and prompt are already on disk and usable. If Warp will not
  // open, say so and hand back the path rather than throwing away the work.
  try {
    const launch = await launchWarp({
      strategy: config.settings.warpStrategy,
      preview: config.settings.warpPreview,
      spec: {
        name: warpConfigName(worktree.branch),
        title: tabTitle(prompt.label, repoLabel),
        color: colorForPrompt(promptKey),
        cwd: worktree.path,
        command: files.scriptFile,
      },
      pendingFile: files.pendingFile,
    });

    log.info(`session ready: ${worktree.path} (${launch.strategy})`);
    return {
      ...base,
      launchStrategy: launch.strategy,
      fellBackToNewTab: launch.fellBack,
      ...(launch.agentStarted === false ? { launchError: AGENT_DID_NOT_START } : {}),
    };
  } catch (err) {
    const { message } = describeError(err);
    log.error(`worktree ready at ${worktree.path} but Warp did not open: ${message}`);
    return {
      ...base,
      launchStrategy: config.settings.warpStrategy,
      fellBackToNewTab: false,
      launchError: message,
    };
  }
}

/**
 * Warp opened on the worktree, but nothing ran autorun.sh: Warp ignored the
 * launch config and the shell hook that would catch that is not installed.
 */
const AGENT_DID_NOT_START =
  "Warp opened but the agent did not start. Run `sidequest install-hook`, then `sidequest reopen`.";

interface ContextExtras {
  branch: string;
  baseBranch: string;
  repo: string;
  worktree: string;
  threadLimit: number;
  ticket: LinearTicket | null;
}

function buildContext(message: MessageContext, extras: ContextExtras): PromptContext {
  return {
    author: message.authorName,
    channel: message.channelName,
    message: quote(stripSlackMarkup(message.text)),
    thread: formatThread(message.threadMessages, extras.threadLimit),
    permalink: message.permalink,
    date: messageDate(message.ts).toISOString(),
    branch: extras.branch,
    baseBranch: extras.baseBranch,
    repo: extras.repo,
    worktree: extras.worktree,
    ticket: extras.ticket?.url ?? "",
    ticketId: extras.ticket?.id ?? "",
    question: formatQuestion(message.question ?? ""),
  };
}

/**
 * Slack renders a message's timestamp as epoch seconds with a sub-second
 * suffix. The overlay reads it off the DOM when it can; when it cannot, the
 * message is still worth a session, so fall back to now rather than to 1970.
 */
function messageDate(ts: string): Date {
  const seconds = Number.parseInt(ts.split(".")[0] ?? "", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/** Markdown blockquote, so the report is visually separate from instructions. */
function quote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "> (the message had no text)";
  return trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatThread(
  messages: Array<{ author: string; text: string }>,
  limit: number,
): string {
  if (limit <= 0 || messages.length === 0) return "";
  const slice = messages.slice(-limit);
  const body = slice
    .map((m) => `**@${m.author}:** ${stripSlackMarkup(m.text).trim()}`)
    .join("\n\n");
  return `\n### Thread replies\n${body}\n`;
}

/** The Ask box's text, set apart like the thread so it reads as mine, not the report's. */
function formatQuestion(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return `\n## My question\n${trimmed}\n`;
}
