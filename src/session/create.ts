import { basename } from "node:path";
import { loadConfig, promptFor } from "../config/store.js";
import { renderPrompt, type PromptContext } from "../config/prompts.js";
import type { Config, PromptKey, RepoLink } from "../config/schema.js";
import { inspectRepo } from "../git/repo.js";
import { createWorktree } from "../git/worktree.js";
import { writeAutorun } from "../warp/autorun.js";
import { colorForPrompt, launchWarp } from "../warp/launcher.js";
import { branchNameFor, tabTitle, warpConfigName } from "./naming.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { stripSlackMarkup } from "../util/slug.js";
import { log } from "../util/log.js";

/** Everything the Slack layer knows about the message that was clicked. */
export interface MessageContext {
  channelId: string;
  channelName: string;
  authorName: string;
  text: string;
  ts: string;
  permalink: string;
  /** Surrounding thread replies, oldest first, already trimmed to the limit. */
  threadMessages: Array<{ author: string; text: string }>;
}

export interface SessionResult {
  branch: string;
  worktreePath: string;
  repoPath: string;
  repoLabel: string;
  baseBranch: string;
  promptLabel: string;
  launchStrategy: string;
  fellBackToNewTab: boolean;
  promptFile: string;
  /** Set when the worktree is ready but Warp could not be opened. */
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
  const link = config.channels[message.channelId];

  if (!link) {
    throw new UserFacingError(
      `No repo is linked to #${message.channelName}.`,
      "Link one with `/ccslack link ~/path/to/repo` in this channel.",
    );
  }

  const repo = await inspectRepo(link.repoPath);
  const baseBranch = link.baseBranch.trim() || repo.defaultBranch;
  const repoLabel = link.label.trim() || repo.name;
  const prompt = promptFor(config, promptKey);

  const branch = branchNameFor({
    promptKey,
    branchPrefix: prompt.branchPrefix,
    messageText: message.text,
    messageTs: message.ts,
  });

  const worktree = await createWorktree({
    repo,
    branch,
    baseBranch,
    worktreesRoot: config.settings.worktreesRoot,
    fetch: config.settings.fetchBeforeCreate,
  });

  const body = renderPrompt(prompt.template, buildContext(message, {
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    repo: repo.root,
    worktree: worktree.path,
    threadLimit: config.settings.threadContextLimit,
  }));

  const files = await writeAutorun({
    worktreePath: worktree.path,
    prompt: body,
    claudeCommand: config.settings.claudeCommand,
    claudeArgs: config.settings.claudeArgs,
  });

  const base = {
    branch: worktree.branch,
    worktreePath: worktree.path,
    repoPath: repo.root,
    repoLabel,
    baseBranch: worktree.baseBranch,
    promptLabel: prompt.label,
    promptFile: files.promptFile,
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
    });

    log.info(`session ready: ${worktree.path} (${launch.strategy})`);
    return {
      ...base,
      launchStrategy: launch.strategy,
      fellBackToNewTab: launch.fellBack,
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

interface ContextExtras {
  branch: string;
  baseBranch: string;
  repo: string;
  worktree: string;
  threadLimit: number;
}

function buildContext(message: MessageContext, extras: ContextExtras): PromptContext {
  return {
    author: message.authorName,
    channel: message.channelName,
    message: quote(stripSlackMarkup(message.text)),
    thread: formatThread(message.threadMessages, extras.threadLimit),
    permalink: message.permalink,
    date: new Date(Number(message.ts.split(".")[0] ?? 0) * 1000).toISOString(),
    branch: extras.branch,
    baseBranch: extras.baseBranch,
    repo: extras.repo,
    worktree: extras.worktree,
  };
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

/** Human-readable repo label for a link, without touching the filesystem. */
export function labelForLink(link: RepoLink): string {
  return link.label.trim() || basename(link.repoPath);
}
