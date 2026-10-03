import {
  addLink,
  channelKey,
  linkLabel,
  linkedRepoPaths,
  linksForChannel,
  removeLink,
} from "../config/channels.js";
import { expandPath, loadConfig, promptFor, updateConfig } from "../config/store.js";
import type { Config } from "../config/schema.js";
import { resolveAgent } from "../agents/agents.js";
import { discoverRepos } from "../git/discover.js";
import { prefetchForChannel } from "../git/prefetch.js";
import { forgetRepos, inspectRepo } from "../git/repo.js";
import type { IncomingAttachment } from "../session/attachments.js";
import { createSession, type MessageContext } from "../session/create.js";
import { computeStats, loadHistory, recordSession, updateSession, type HistoryEntry } from "../session/history.js";
import { findSession, openSession } from "../session/reopen.js";
import { readResult, resultReply } from "../session/result.js";
import { findById, listSessions, removeSession, UncommittedWorkError } from "../session/sessions.js";
import type { SessionStatus } from "../session/status.js";
import { describeError } from "../util/errors.js";
import { log } from "../util/log.js";

/** Plenty for a question; a paste of a whole log belongs in the terminal. */
const MAX_QUESTION = 4000;

export interface AttacherEvent {
  type: string;
  message?: string;
  target?: string;
  channel?: string;
  prompt?: string;
  branch?: string;
}

/** A request coming up from the injected overlay. */
export interface AskRequest {
  id: string;
  op: string;
  channel?: string;
  promptKey?: string;
  text?: string;
  sender?: string;
  ts?: string;
  permalink?: string;
  thread?: Array<{ author: string; text: string }>;
  /** Linear, GitHub or Jira issue URL the message links, for that prompt. */
  ticket?: string;
  /** What the user typed into the Ask box. */
  question?: string;
  /** A path to link, for link-repo. */
  repoPath?: string;
  /** Which of the channel's repos: the one to start in, or the one to unlink. */
  repo?: string;
  branch?: string;
  /** Files attached to the message, fetched by the overlay. */
  attachments?: IncomingAttachment[];
  /** For result-posted: which write of result.md was posted, and whether it failed or was dismissed. */
  resultMs?: number;
  error?: string;
  dismissed?: boolean;
  /** A session in the sessions panel, by its worktree's directory name. */
  session?: string;
  /** Remove a session even though it has uncommitted changes. */
  force?: boolean;
}

/** What the handlers need from the attacher that received the request. */
export interface RequestHost {
  emit(event: AttacherEvent): void;
  broadcastConfig(): Promise<void>;
  refreshStatuses(): Promise<void>;
  followAgentCheck(branch: string, channel: string, check: Promise<string | null>): void;
  status(branch: string): SessionStatus | undefined;
}

/** The reply for the page (its id is added on the way out), and anything to do once it has it. */
export interface Answer {
  reply: Record<string, unknown>;
  after?: () => Promise<void>;
}

type Handler = (request: AskRequest, host: RequestHost) => Promise<Answer>;

const HANDLERS: Record<string, Handler> = {
  "start-session": startSession,
  "link-repo": linkRepo,
  "channel-status": channelStatus,
  prefetch,
  "suggest-repos": suggestRepos,
  reopen,
  "get-result": getResult,
  "result-posted": resultPosted,
  "list-sessions": listSessionsForPanel,
  "remove-session": removeSessionFromPanel,
};

/**
 * What a failed request still owes the page besides the error, so the
 * overlay can draw an empty list rather than keep the stale one.
 */
const ON_ERROR: Record<string, Record<string, unknown>> = {
  "channel-status": { repos: [] },
  "suggest-repos": { repos: [] },
  "list-sessions": { sessions: [] },
};

/** Answer one request. A handler that throws becomes an error reply, never a silence. */
export async function answer(request: AskRequest, host: RequestHost): Promise<Answer> {
  const handler = HANDLERS[request.op];
  if (!handler) return { reply: { error: `unknown op ${request.op}` } };
  try {
    return await handler(request, host);
  } catch (err) {
    const { message, hint } = describeError(err);
    const dirty = err instanceof UncommittedWorkError ? err.dirty : undefined;
    return { reply: { error: message, hint, dirty, ...ON_ERROR[request.op] } };
  }
}

/** Who wrote a session's reply: the agent it was started with, or today's for older sessions. */
function replyAgent(entry: HistoryEntry, config: Config): string {
  return entry.agentLabel || resolveAgent(config.settings.agent).label;
}

/** Look in on the sessions without waiting: after a reply, nobody is left to hear a failure. */
function refreshStatusesSoon(host: RequestHost): void {
  void host.refreshStatuses().catch((err) => {
    host.emit({ type: "status-error", message: describeError(err).message });
  });
}

async function startSession(request: AskRequest, host: RequestHost): Promise<Answer> {
  const promptKey = String(request.promptKey ?? "");
  // Read once and handed on, so the session is cut from the config checked here.
  const config = await loadConfig();
  if (!promptFor(config, promptKey)) return { reply: { error: "unknown prompt" } };

  const context: MessageContext = {
    channelName: request.channel ?? "",
    authorName: request.sender ?? "unknown",
    text: request.text ?? "",
    ts: request.ts ?? "",
    permalink: request.permalink ?? "",
    threadMessages: request.thread ?? [],
    ticket: request.ticket ?? "",
    question: typeof request.question === "string" ? request.question.slice(0, MAX_QUESTION) : "",
    repo: typeof request.repo === "string" ? request.repo : "",
    attachments: Array.isArray(request.attachments) ? request.attachments : [],
  };

  let result;
  try {
    result = await createSession(promptKey, context, config);
  } catch (err) {
    host.emit({ type: "session-error", channel: context.channelName, message: describeError(err).message });
    throw err;
  }
  host.emit({ type: "session", channel: context.channelName, prompt: promptKey, branch: result.branch });

  // The session exists whatever happens next; a history that cannot be
  // written costs the streak, not the session.
  let stats = null;
  try {
    const history = await recordSession({
      ts: context.ts,
      channel: channelKey(context.channelName),
      promptKey,
      promptLabel: result.promptLabel,
      branch: result.branch,
      worktreePath: result.worktreePath,
      repoPath: result.repoPath,
      repoLabel: result.repoLabel,
      createdAt: new Date().toISOString(),
      permalink: context.permalink,
      baseBranch: result.baseBranch,
      agentLabel: result.agentLabel,
    });
    stats = computeStats(history);
  } catch (err) {
    host.emit({ type: "history-error", message: describeError(err).message });
  }

  const { branch, agentCheck } = result;
  return {
    reply: {
      ok: true,
      branch,
      worktree: result.worktreePath,
      repo: result.repoLabel,
      stats,
      // Posted by the overlay, which is signed in to Slack; empty means don't.
      reply: result.reply,
      // The overlay says so on the message rather than failing silently.
      warning: result.launchError,
      attachments: result.attachments,
    },
    after: async () => {
      if (agentCheck) host.followAgentCheck(branch, context.channelName, agentCheck);
      await host.broadcastConfig();
      refreshStatusesSoon(host);
    },
  };
}

/**
 * Link the channel the reader is looking at to a repo. The page knows the
 * channel; the daemon owns the mapping and the filesystem, so it validates
 * the path and answers with what it actually stored.
 *
 * A path adds that repo to the channel's list (a channel can have several).
 * Otherwise `repo` names the one to unlink, and neither unlinks them all.
 */
async function linkRepo(request: AskRequest, host: RequestHost): Promise<Answer> {
  const key = channelKey(request.channel ?? "");
  if (!key) return { reply: { error: "no channel to link" } };
  const after = () => host.broadcastConfig();

  const raw = (request.repoPath ?? "").trim();
  if (raw.length === 0) {
    const which = (request.repo ?? "").trim();
    const { removed, left } = await updateConfig((config) => {
      const removed = removeLink(config, key, which);
      return { removed, left: linksForChannel(config, key).map(linkLabel) };
    });
    forgetRepos();
    if (which && removed.length === 0) {
      return { reply: { error: `${which} is not linked to #${key}.`, repos: left }, after };
    }
    for (const link of removed) host.emit({ type: "unlink", channel: key, message: link.repoPath });
    return {
      reply: { ok: true, linked: left.length > 0, removed: removed.map(linkLabel), repos: left },
      after,
    };
  }

  const repo = await inspectRepo(expandPath(raw));
  const { stored, labels } = await updateConfig((config) => {
    const stored = addLink(config, key, {
      repoPath: repo.root,
      channel: key,
      baseBranch: "",
      label: "",
      linkedBy: "overlay",
      linkedAt: new Date().toISOString(),
    });
    return { stored, labels: linksForChannel(config, key).map(linkLabel) };
  });
  forgetRepos();
  host.emit({ type: "link", channel: key, message: repo.root });
  return {
    reply: { ok: true, linked: true, repo: linkLabel(stored), repoPath: repo.root, repos: labels },
    after,
  };
}

async function channelStatus(request: AskRequest): Promise<Answer> {
  const links = linksForChannel(await loadConfig(), request.channel ?? "");
  return {
    reply: {
      linked: links.length > 0,
      repo: links[0] ? linkLabel(links[0]) : "",
      repoPath: links[0]?.repoPath ?? "",
      repos: links.map(linkLabel),
    },
  };
}

/**
 * The menu opened on a message in a linked channel: start fetching the base
 * its session would be cut from, so a click finds it already fetched. The
 * overlay does not wait on this, so it is answered before the fetch starts.
 */
async function prefetch(request: AskRequest): Promise<Answer> {
  const channel = request.channel ?? "";
  return {
    reply: { ok: true },
    after: async () => {
      try {
        await prefetchForChannel(await loadConfig(), channel, request.repo ?? "");
      } catch (err) {
        // A click will run into the same problem and say so; this one is quiet.
        log.debug(`could not prefetch for #${channel}: ${describeError(err).message}`);
      }
    },
  };
}

/** Repos worth offering for this channel, best match first. */
async function suggestRepos(request: AskRequest): Promise<Answer> {
  const config = await loadConfig();
  const channel = channelKey(request.channel ?? "");
  // Already on this channel is not a suggestion for it.
  const own = new Set(linksForChannel(config, channel).map((l) => l.repoPath));
  const { repoSearchRoots, worktreesRoot } = config.settings;
  const found = await discoverRepos({
    channel,
    linkedRepos: linkedRepoPaths(config),
    worktreesRoot,
    roots: repoSearchRoots.length > 0 ? repoSearchRoots.map(expandPath) : undefined,
  });
  return { reply: { ok: true, repos: found.filter((r) => !own.has(r.path)) } };
}

/**
 * Back into a session started earlier, from the mark on its message — by
 * branch — or from the sessions panel, by its worktree's name, which cannot
 * be mistaken for a same-named branch in another repo.
 */
async function reopen(request: AskRequest, host: RequestHost): Promise<Answer> {
  const id = typeof request.session === "string" ? request.session.trim() : "";
  const wanted = (request.branch ?? "").trim();
  const config = await loadConfig();
  const history = await loadHistory();
  const known = history.filter((h) => h.branch === wanted).map((h) => h.repoPath);
  const found = id
    ? await findById(config, history, id)
    : wanted ? await findSession(config, wanted, known) : null;
  if (!found) {
    return {
      reply: {
        error: `${wanted || "That session"} is gone.`,
        hint: "It was probably cleaned up — start a new one from the menu.",
      },
    };
  }
  const branch = found.worktree.branch;
  await openSession(config, found);
  host.emit({ type: "reopen", branch });
  return { reply: { ok: true, branch } };
}

/** A session's reply for the thread, ready to read, edit and post. */
async function getResult(request: AskRequest, host: RequestHost): Promise<Answer> {
  const branch = (request.branch ?? "").trim();
  const entry = (await loadHistory()).reverse().find((h) => h.branch === branch);
  const result = entry ? await readResult(entry.worktreePath) : null;
  if (!entry || !result) return { reply: { error: `${branch || "That session"} has no reply to post.` } };
  const config = await loadConfig();
  return {
    reply: {
      ok: true,
      branch,
      label: entry.promptLabel,
      channel: entry.channel,
      permalink: entry.permalink ?? "",
      resultMs: result.mtimeMs,
      agent: replyAgent(entry, config),
      text: sessionReply(entry, result.text, host.status(branch)?.pr?.url, config),
    },
  };
}

/**
 * The page posted a reply (or was told not to): remember which write of
 * result.md that was, so it is not offered again unless the agent rewrites it.
 */
async function resultPosted(request: AskRequest, host: RequestHost): Promise<Answer> {
  const branch = (request.branch ?? "").trim();
  if (request.error) {
    host.emit({ type: "result-error", branch, message: request.error });
    return { reply: { ok: true } };
  }
  const resultMs = typeof request.resultMs === "number" ? request.resultMs : Date.now();
  await updateSession(branch, { resultPostedMs: resultMs });
  host.emit({ type: request.dismissed ? "result-dismissed" : "result-posted", branch });
  return {
    reply: { ok: true },
    after: async () => {
      await host.refreshStatuses();
      await host.broadcastConfig();
    },
  };
}

/**
 * The sessions panel's list. Asked for each time the panel opens, so it
 * says what git says now rather than what the config said at inject time.
 */
async function listSessionsForPanel(): Promise<Answer> {
  return { reply: { ok: true, sessions: await listSessions(await loadConfig(), await loadHistory()) } };
}

/**
 * Remove a finished session from the panel. Uncommitted work is refused
 * with how much of it there is, so the page can ask before sending `force`.
 */
async function removeSessionFromPanel(request: AskRequest, host: RequestHost): Promise<Answer> {
  const result = await removeSession(await loadConfig(), await loadHistory(), request.session ?? "", {
    force: request.force === true,
  });
  host.emit({ type: "remove-session", branch: result.branch });
  // Its mark now says it was cleaned up.
  return { reply: { ok: true, ...result }, after: async () => refreshStatusesSoon(host) };
}

/** A session's result as the thread reply the page posts. */
export function sessionReply(entry: HistoryEntry, text: string, prUrl: string | undefined, config: Config): string {
  return resultReply(text, { prUrl, agent: replyAgent(entry, config) });
}
