import { loadConfig, promptFor } from "../config/store.js";
import { linksForChannel, repoForChannelName } from "../config/channels.js";
import { renderPrompt, renderReply } from "../config/prompts.js";
import { firstTicket, isTicketPrompt, keepsBranchCase, ticketFor } from "../config/tickets.js";
import { agentConfigFor, followUpArgs, linkPrompt, resolveAgent, type DesktopApp, type ResolvedAgent } from "../agents/agents.js";
import type { Config } from "../config/schema.js";
import { defaultBranchCached, forgetRepos, locateRepoCached } from "../git/repo.js";
import { createWorktree } from "../git/worktree.js";
import { autorunPaths, writeAutorun } from "../warp/autorun.js";
import { colorForPrompt, prepareTabConfig, strategyOrder, type PreparedTabConfig } from "../warp/launcher.js";
import { removeTabConfig, type WarpSessionSpec } from "../warp/configFiles.js";
import { writeHeadlessRunner } from "../terminals/headless.js";
import { agentDidNotStart, launchTerminal, type TerminalLaunchOptions } from "../terminals/launch.js";
import { sessionHost } from "../terminals/registry.js";
import { branchNameFor, tabTitle, warpConfigName } from "./naming.js";
import { formatAttachments, saveAttachments, type IncomingAttachment } from "./attachments.js";
import { buildContext } from "./context.js";
import { resultInstructions } from "./result.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { openUri } from "../util/openUri.js";
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
  /** Files attached to the message, fetched by the overlay. */
  attachments?: IncomingAttachment[];
}

export interface SessionResult {
  branch: string;
  worktreePath: string;
  repoPath: string;
  repoLabel: string;
  baseBranch: string;
  promptLabel: string;
  agentLabel: string;
  /** The agent's id, so reopening it later runs the same one. */
  agentId: string;
  /** Where the session opened, e.g. "iTerm2", "the background" or "the Claude app". */
  host: string;
  launchStrategy: string;
  fellBackToNewTab: boolean;
  promptFile: string;
  /**
   * What to post in the message's thread, rendered; empty when
   * settings.autoReply is off or the prompt has no reply.
   */
  reply: string;
  /** How many of the message's files were saved into the worktree. */
  attachments: number;
  /** Set when the worktree is ready but the terminal or the agent's app could not be opened, or the agent did not start. */
  launchError?: string;
  /**
   * Set when the session was handed back as soon as the terminal opened,
   * before the agent had claimed it: settles once that is known, with what
   * to tell the user if the agent did not start (null when it did, or when
   * there was nothing to watch). Never rejects.
   */
  agentCheck?: Promise<string | null>;
}

/**
 * The whole flow behind one button click: resolve the channel's repo, cut a
 * worktree, render the prompt into it, and open the terminal there (or the
 * agent's desktop app, for an agent that lives in one).
 */
export async function createSession(
  promptKey: string,
  message: MessageContext,
  configOverride?: Config,
): Promise<SessionResult> {
  const startedAt = Date.now();
  const config = configOverride ?? (await loadConfig());
  const prompt = promptFor(config, promptKey);
  if (!prompt) {
    throw new UserFacingError(
      `There is no "${promptKey}" prompt any more.`,
      "Reload Slack to pick up the prompts as they are now.",
    );
  }
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

  const repo = await locateRepoCached(link.repoPath);
  // A link that names its base needs no guessing at the default branch.
  const baseBranch = link.baseBranch.trim() || (await defaultBranchCached(repo));
  const repoLabel = link.label.trim() || repo.name;
  const agentConfig = agentConfigFor(config.settings.agent, prompt.agent);
  const agent = resolveAgent(agentConfig);
  const terminal = config.settings.terminal;

  // Checked before anything is cut, like the ticket above. An agent
  // in a desktop app ignores the terminal setting, headless included.
  if (!agent.app && terminal === "headless" && !agent.headless) {
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
  // write it while git fetches and checks the worktree out rather than after.
  let preparedTabConfig: PreparedTabConfig | undefined;
  const preview = config.settings.warpPreview;
  const tabConfigFirst =
    !agent.app && terminal === "warp" && strategyOrder(config.settings.warpStrategy)[0] === "tab_config";

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
    // The repo may have moved or changed under what was remembered about it.
    forgetRepos();
    throw err;
  });

  // Best-effort: a screenshot that will not save is no reason to lose the session.
  const attachments = await saveAttachments(worktree.path, message.attachments).catch((err: unknown) => {
    log.warn(`could not save the message's attachments: ${describeError(err).message}`);
    return [];
  });

  const context = buildContext(message, {
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    repo: repo.root,
    worktree: worktree.path,
    threadLimit: config.settings.threadContextLimit,
    ticket,
    attachments: formatAttachments(attachments),
  });
  let body = renderPrompt(prompt.template, context);
  // A template written before attachments existed still gets told about them.
  if (context.attachments && !/\{\{\s*attachments\s*\}\}/.test(prompt.template)) {
    body = `${body.trimEnd()}\n${context.attachments}`;
  }
  body += resultInstructions(config.settings.postResults);
  const reply = config.settings.autoReply
    ? renderReply(prompt.reply, context, repoLabel, message.question ?? "")
    : "";

  const files = await writeAutorun({
    worktreePath: worktree.path,
    prompt: body,
    agentCommand: agent.command,
    agentArgs: agent.args,
    promptArgs: agent.promptArgs,
    ...(agent.resumeArgs ? { resumeArgs: agent.resumeArgs } : {}),
    ...(agent.continueArgs ? { continueArgs: agent.continueArgs } : {}),
    followUpArgs: followUpArgs(agent),
    agentLabel: agent.label,
    title,
    pending: !agent.app,
  });
  const headless =
    !agent.app && terminal === "headless" && agent.headless
      ? await writeHeadlessRunner({
          worktreePath: worktree.path,
          agentCommand: agent.command,
          agentArgs: agentConfig.args,
          headless: agent.headless,
          agentLabel: agent.label,
        })
      : null;
  const host = sessionHost(agent, terminal);

  const base: SessionBase = {
    branch: worktree.branch,
    worktreePath: worktree.path,
    repoPath: repo.root,
    repoLabel,
    baseBranch: worktree.baseBranch,
    promptLabel: prompt.label,
    promptFile: files.promptFile,
    agentLabel: agent.label,
    agentId: agent.id,
    host,
    reply,
    attachments: attachments.length,
  };

  // An agent in a desktop app opens there; the terminal setting doesn't apply.
  if (agent.app) return openInApp(agent, agent.app, worktree.path, body, base, startedAt);

  const spec = specFor(worktree);
  return openInTerminal(
    {
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
    },
    base,
    startedAt,
  );
}

type SessionBase = Omit<SessionResult, "launchStrategy" | "fellBackToNewTab">;

/**
 * Open the configured terminal on the worktree. The worktree and prompt are
 * already on disk and usable, so a terminal that will not open is reported
 * with the path rather than thrown, which would throw away the work.
 */
async function openInTerminal(
  options: Omit<TerminalLaunchOptions, "onOpened">,
  base: SessionBase,
  startedAt: number,
): Promise<SessionResult> {
  const { settings } = options;
  const { terminal } = settings;
  const { host, worktreePath } = base;
  try {
    // Hand the session back the moment the terminal is open, rather than
    // after the agent has claimed it, which takes seconds when it works and,
    // through Warp's fallbacks, the better part of twenty when it does not.
    // Whether it started follows in agentCheck.
    let markOpened!: (opened: { strategy: string; fellBack: boolean }) => void;
    const opened = new Promise<{ strategy: string; fellBack: boolean }>((resolve) => {
      markOpened = resolve;
    });
    const launching = launchTerminal({ ...options, onOpened: markOpened });
    const first = await Promise.race([
      launching.then((launch) => ({ launch, opened: null })),
      opened.then((info) => ({ launch: null, opened: info })),
    ]);

    if (first.opened) {
      log.info(`session ready in ${Date.now() - startedAt}ms: ${worktreePath} (${first.opened.strategy})`);
      const agentCheck = launching.then(
        (launch) => {
          if (launch.agentStarted !== false) return null;
          log.warn(`${host} opened on ${worktreePath} but the agent did not start`);
          return agentDidNotStart(terminal);
        },
        (err: unknown) => describeError(err).message,
      );
      return {
        ...base,
        launchStrategy: first.opened.strategy,
        fellBackToNewTab: first.opened.fellBack,
        agentCheck,
      };
    }

    const launch = first.launch!;
    log.info(`session ready in ${Date.now() - startedAt}ms: ${worktreePath} (${launch.strategy})`);
    return {
      ...base,
      launchStrategy: launch.strategy,
      fellBackToNewTab: launch.fellBack,
      ...(launch.agentStarted === false ? { launchError: agentDidNotStart(terminal) } : {}),
    };
  } catch (err) {
    const { message } = describeError(err);
    log.error(`worktree ready at ${worktreePath} but ${host} did not open: ${message}`);
    return {
      ...base,
      launchStrategy: terminal === "warp" ? settings.warpStrategy : terminal,
      fellBackToNewTab: false,
      launchError: message,
    };
  }
}

/**
 * Start the session in the agent's desktop app: a new session there, in the
 * worktree, with the prompt in the composer. Like Warp, a failure to open it
 * leaves the worktree and prompt in place and says so.
 */
async function openInApp(
  agent: ResolvedAgent,
  app: DesktopApp,
  worktreePath: string,
  prompt: string,
  base: SessionBase,
  startedAt: number,
): Promise<SessionResult> {
  const uri = app.newSessionUri(worktreePath, linkPrompt(prompt));
  try {
    await openUri(uri, agent.host, `Is ${agent.host} installed? \`sidequest doctor\` checks.`);
    log.info(`session ready in ${Date.now() - startedAt}ms: ${worktreePath} (${agent.id})`);
    return { ...base, launchStrategy: agent.id, fellBackToNewTab: false };
  } catch (err) {
    const { message } = describeError(err);
    log.error(`worktree ready at ${worktreePath} but ${agent.host} did not open: ${message}`);
    return { ...base, launchStrategy: agent.id, fellBackToNewTab: false, launchError: message };
  }
}

/** For the error when a ticket prompt arrives without its link. */
const TRACKER_NAMES = { linear: "Linear", github: "GitHub", jira: "Jira" } as const;
