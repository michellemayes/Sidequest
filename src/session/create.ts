import { loadConfig, promptFor } from "../config/store.js";
import { linksForChannel, repoForChannelName } from "../config/channels.js";
import { renderPrompt, renderReply, type PromptContext } from "../config/prompts.js";
import { firstTicket, isTicketPrompt, keepsBranchCase, ticketFor, type Ticket } from "../config/tickets.js";
import { resolveAgent } from "../agents/agents.js";
import type { Config, PromptKey } from "../config/schema.js";
import { inspectRepo } from "../git/repo.js";
import { createWorktree } from "../git/worktree.js";
import { autorunPaths, writeAutorun } from "../warp/autorun.js";
import { colorForPrompt, prepareTabConfig, strategyOrder, type PreparedTabConfig } from "../warp/launcher.js";
import { removeTabConfig, type WarpSessionSpec } from "../warp/configFiles.js";
import { writeHeadlessRunner } from "../terminals/headless.js";
import { agentDidNotStart, launchTerminal } from "../terminals/launch.js";
import { terminalDefinition } from "../terminals/registry.js";
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
  /** Linear, GitHub or Jira issue URL the message links; only their prompts need it. */
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
  /** The terminal the session opened in, e.g. "iTerm2". */
  terminalLabel: string;
  launchStrategy: string;
  fellBackToNewTab: boolean;
  promptFile: string;
  /**
   * What to post in the message's thread, rendered; empty when
   * settings.autoReply is off or the prompt has no reply.
   */
  reply: string;
  /** Set when the worktree is ready but the terminal could not be opened, or the agent did not start. */
  launchError?: string;
}

/**
 * The whole flow behind one button click: resolve the channel's repo, cut a
 * worktree, render the prompt into it, and open the terminal there.
 */
export async function createSession(
  promptKey: PromptKey,
  message: MessageContext,
  configOverride?: Config,
): Promise<SessionResult> {
  const startedAt = Date.now();
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

  // Checked before anything is cut: a ticket session with no ticket is
  // just a Fix with the wrong name.
  const ticketPrompt = isTicketPrompt(promptKey) ? promptKey : null;
  const ticket = ticketPrompt ? ticketFor(ticketPrompt, message.ticket ?? "") : firstTicket(message.ticket ?? "");
  if (ticketPrompt && !ticket) {
    throw new UserFacingError(`That message has no ${TRACKER_NAMES[ticketPrompt]} issue link to work from.`);
  }

  const repo = await inspectRepo(link.repoPath);
  const baseBranch = link.baseBranch.trim() || repo.defaultBranch;
  const repoLabel = link.label.trim() || repo.name;
  const prompt = promptFor(config, promptKey);
  const agent = resolveAgent(config.settings.agent);
  const terminal = config.settings.terminal;

  // Checked before anything is cut, like the Linear ticket above.
  if (terminal === "headless" && !agent.headless) {
    throw new UserFacingError(
      `${agent.label} has no headless mode.`,
      "Pick another agent with `sidequest agents`, or a terminal with `sidequest terminal`.",
    );
  }

  const branch = branchNameFor({
    promptKey,
    branchPrefix: prompt.branchPrefix,
    // A ticket's branch is named for it, which the tracker then links it to.
    messageText: ticketPrompt && ticket?.slug ? ticket.slug : message.text,
    messageTs: message.ts,
    ticketId: ticketPrompt ? ticket?.branchKey : undefined,
    keepTicketCase: ticketPrompt ? keepsBranchCase(ticketPrompt) : false,
  });

  const title = tabTitle(prompt.label, repoLabel);
  const specFor = (names: { branch: string; path: string }): WarpSessionSpec => ({
    name: warpConfigName(names.branch),
    color: colorForPrompt(promptKey),
    cwd: names.path,
    command: autorunPaths(names.path).scriptFile,
  });

  // A tab config has to sit on disk a moment before Warp will open it, so
  // write it while git checks the worktree out rather than after.
  let preparedTabConfig: PreparedTabConfig | undefined;
  const preview = config.settings.warpPreview;
  const tabConfigFirst =
    terminal === "warp" && strategyOrder(config.settings.warpStrategy)[0] === "tab_config";

  let tabConfigName: string | undefined;
  const worktree = await createWorktree({
    repo,
    branch,
    baseBranch,
    worktreesRoot: config.settings.worktreesRoot,
    fetch: config.settings.fetchBeforeCreate,
    alongsideCheckout: tabConfigFirst
      ? async (names) => {
          try {
            const spec = specFor(names);
            tabConfigName = spec.name;
            preparedTabConfig = await prepareTabConfig(spec, preview);
          } catch (err) {
            // The launcher writes it again when it gets there.
            log.debug(`could not write the tab config early: ${describeError(err).message}`);
          }
        }
      : undefined,
  }).catch(async (err: unknown) => {
    // No worktree, so no tab to open: don't leave Warp a config pointing nowhere.
    if (tabConfigName) await removeTabConfig(tabConfigName, preview).catch(() => {});
    throw err;
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
  const reply = config.settings.autoReply
    ? renderReply(prompt.reply, context, repoLabel, message.question ?? "")
    : "";

  const files = await writeAutorun({
    worktreePath: worktree.path,
    prompt: body,
    agentCommand: agent.command,
    agentArgs: agent.args,
    agentLabel: agent.label,
    title,
  });
  const headless =
    terminal === "headless" && agent.headless
      ? await writeHeadlessRunner({
          worktreePath: worktree.path,
          agentCommand: agent.command,
          agentArgs: config.settings.agent.args,
          headless: agent.headless,
          agentLabel: agent.label,
        })
      : null;
  const terminalLabel = terminalDefinition(terminal).label;

  const base = {
    branch: worktree.branch,
    worktreePath: worktree.path,
    repoPath: repo.root,
    repoLabel,
    baseBranch: worktree.baseBranch,
    promptLabel: prompt.label,
    promptFile: files.promptFile,
    agentLabel: agent.label,
    terminalLabel,
    reply,
  };

  // The worktree and prompt are already on disk and usable. If the terminal
  // will not open, say so and hand back the path rather than throwing away
  // the work.
  try {
    const spec = specFor(worktree);
    const launch = await launchTerminal({
      settings: config.settings,
      session: {
        name: spec.name,
        color: spec.color,
        title,
        cwd: worktree.path,
        script: headless?.scriptFile ?? files.scriptFile,
        pendingFile: files.pendingFile,
      },
      preparedTabConfig,
    });

    log.info(`session ready in ${Date.now() - startedAt}ms: ${worktree.path} (${launch.strategy})`);
    return {
      ...base,
      launchStrategy: launch.strategy,
      fellBackToNewTab: launch.fellBack,
      ...(launch.agentStarted === false ? { launchError: agentDidNotStart(terminal) } : {}),
    };
  } catch (err) {
    const { message } = describeError(err);
    log.error(`worktree ready at ${worktree.path} but ${terminalLabel} did not open: ${message}`);
    return {
      ...base,
      launchStrategy: terminal === "warp" ? config.settings.warpStrategy : terminal,
      fellBackToNewTab: false,
      launchError: message,
    };
  }
}

/** For the error when a ticket prompt arrives without its link. */
const TRACKER_NAMES = { linear: "Linear", github: "GitHub", jira: "Jira" } as const;

interface ContextExtras {
  branch: string;
  baseBranch: string;
  repo: string;
  worktree: string;
  threadLimit: number;
  ticket: Ticket | null;
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
