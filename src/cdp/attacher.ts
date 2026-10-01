import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CdpSession,
  CLOSE_EVENT,
  isAttachableTarget,
  listTargets,
  type CdpTarget,
} from "./client.js";
import { pageConfig } from "../config/pageConfig.js";
import {
  addLink,
  channelKey,
  linkLabel,
  linkedRepoPaths,
  linksForChannel,
  removeLink,
} from "../config/channels.js";
import { loadConfig, updateConfig, expandPath, promptFor } from "../config/store.js";
import { inspectRepo } from "../git/repo.js";
import { createSession, type MessageContext } from "../session/create.js";
import { computeStats, loadHistory, recordSession, updateSession } from "../session/history.js";
import { StatusWatcher, type SessionStatus } from "../session/status.js";
import { readResult, resultReply } from "../session/result.js";
import type { IncomingAttachment } from "../session/attachments.js";
import { findSession, openSession } from "../session/reopen.js";
import { findById, listSessions, removeSession, UncommittedWorkError } from "../session/sessions.js";
import { discoverRepos } from "../git/discover.js";
import { describeError } from "../util/errors.js";
import { log } from "../util/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/cdp -> dist -> project root. The overlay ships as plain JS, unbuilt,
// so it lives outside src/ and is read at inject time.
const INJECT_PATH = join(HERE, "..", "..", "client", "inject.js");

const BINDING = "__sidequestAsk";
const RESULT_FN = "__sidequestResult";
const POST_RESULT_FN = "__sidequestPostResult";
const POLL_MS = 4000;
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

/** What the most recent sweep saw on the DevTools endpoint. */
export interface SweepSummary {
  /** Every target the endpoint reported, of any type. */
  targets: number;
  /** Those that look like a Slack window. */
  matched: number;
}

/** A request coming up from the injected overlay. */
interface AskRequest {
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

export class Attacher {
  private readonly sessions = new Map<string, CdpSession | null>();
  private readonly targetUrl: RegExp;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sweepSummary: SweepSummary = { targets: 0, matched: 0 };
  /** So a window that never appears is said once, not every four seconds. */
  private reportedEmpty = false;
  /** Follows the recent sessions, for the marks on their messages and their replies. */
  private watcher: StatusWatcher | null = null;
  private statuses = new Map<string, SessionStatus>();
  /** Results already handed to a window to post, as branch + mtime, so each is posted once. */
  private readonly autoPosted = new Set<string>();

  constructor(
    private readonly options: {
      cdpPort: number;
      targetUrlPattern: string;
      onEvent?: (event: AttacherEvent) => void;
      /** How often to look in on sessions; false to not follow them at all. */
      watchIntervalMs?: number | false;
    },
  ) {
    this.targetUrl = new RegExp(options.targetUrlPattern, "i");
  }

  private emit(event: AttacherEvent): void {
    this.options.onEvent?.(event);
  }

  /**
   * Read the overlay on every injection, so editing client/inject.js needs a
   * Slack reload rather than a daemon restart.
   */
  private async source(): Promise<string> {
    const script = readFileSync(INJECT_PATH, "utf8");
    const config = pageConfig(await loadConfig(), await loadHistory(), this.statuses);
    return `window.__SIDEQUEST_CONFIG = ${JSON.stringify(config)};\n${script}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reportedEmpty = false;
    await this.startWatcher();
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.sweep();
      } catch (err) {
        this.emit({ type: "poll-error", message: describeError(err).message });
      }
      if (!this.stopped) {
        // Deliberately not unref'd: this timer is what keeps `sidequest start`
        // alive. An attached window holds the event loop open through its
        // socket, but before the first attach — Slack still starting, a window
        // that has not been opened yet — there is nothing else running, and an
        // unref'd poll would let the daemon exit having printed that it was
        // waiting. `stop()` clears it, so it never outlives a shutdown.
        this.pollTimer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    await tick();
  }

  /** Sweep now rather than on the next poll, e.g. right after Slack relaunches. */
  async sweepNow(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.sweep();
    } catch (err) {
      this.emit({ type: "poll-error", message: describeError(err).message });
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.stop();
    this.watcher = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const session of this.sessions.values()) session?.close();
    this.sessions.clear();
  }

  /** Attach to any Slack window we are not already driving. */
  private async sweep(): Promise<void> {
    const targets = await listTargets(this.options.cdpPort);
    const pages = targets.filter((t) => isAttachableTarget(t, this.targetUrl));
    this.sweepSummary = { targets: targets.length, matched: pages.length };

    if (pages.length === 0 && !this.reportedEmpty) {
      this.reportedEmpty = true;
      // Nothing to attach to is the one failure the daemon cannot see from the
      // outside: the port answers, the poll succeeds, and no overlay appears.
      // Say what was on the endpoint instead of waiting in silence.
      this.emit({ type: "no-targets", message: describeTargets(targets) });
    } else if (pages.length > 0) {
      this.reportedEmpty = false;
    }

    for (const target of pages) {
      if (this.sessions.has(target.id)) continue;
      // Reserve the slot before awaiting, so a second sweep cannot double-attach.
      this.sessions.set(target.id, null);
      try {
        this.sessions.set(target.id, await this.attach(target));
      } catch (err) {
        this.sessions.delete(target.id);
        this.emit({ type: "attach-error", target: target.url, message: describeError(err).message });
      }
    }
  }

  private async attach(target: CdpTarget): Promise<CdpSession> {
    // Built before connecting: it reads the config, and a config that does
    // not parse should cost this sweep nothing rather than a socket to undo.
    const source = await this.source();
    const session = new CdpSession(target.webSocketDebuggerUrl!);
    await session.connect();

    session.on(CLOSE_EVENT, () => {
      // Only a window that finished attaching holds its slot. One that failed
      // partway is closed below and reported by the sweep as an attach error,
      // and by then its slot may belong to the next attempt.
      if (this.sessions.get(target.id) !== session) return;
      this.sessions.delete(target.id);
      // A shutdown closes every socket itself; that is not a window going away.
      if (!this.stopped) this.emit({ type: "detached", target: target.url });
    });

    try {
      await session.send("Page.enable");
      await session.send("Runtime.enable");
      await session.send("Runtime.addBinding", { name: BINDING });

      session.on("Runtime.bindingCalled", (params) => {
        if (params.name !== BINDING) return;
        void this.handleAsk(session, params).catch((err) => {
          this.emit({ type: "ask-error", message: describeError(err).message });
        });
      });

      // Covers navigations and workspace switches...
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
      // ...and the window that is already open right now. A window that ran the
      // overlay before (the daemon restarted under a Slack that stayed open)
      // keeps its overlay, so hand it the config as it is now.
      await session.send("Runtime.evaluate", {
        expression: `${source}\n;window.__sidequestSetConfig && window.__sidequestSetConfig(JSON.stringify(window.__SIDEQUEST_CONFIG));`,
        awaitPromise: false,
      });
    } catch (err) {
      // The sweep forgets this window and tries again on the next poll. Left
      // open, this socket would go on answering clicks alongside the next
      // attempt's, and each click would start one session per leaked socket.
      session.close();
      throw err;
    }

    this.emit({ type: "attached", target: target.url });
    return session;
  }

  /**
   * Follow the recent sessions when either thing that needs it is on: their
   * progress on the Slack marks, or the replies their agents leave.
   */
  private async startWatcher(): Promise<void> {
    if (this.options.watchIntervalMs === false || this.watcher) return;
    let settings;
    try {
      settings = (await loadConfig()).settings;
    } catch {
      return;
    }
    if (!settings.trackStatus && settings.postResults === "off") return;
    this.watcher = new StatusWatcher({
      intervalMs: this.options.watchIntervalMs ?? 15_000,
      pullRequests: settings.trackStatus,
      history: loadHistory,
      onChange: (statuses) => {
        this.statuses = statuses;
        // A config edited into something that does not parse makes this
        // throw; say so, as the other background work does, rather than let
        // the rejection take the daemon down.
        void this.broadcastConfig().catch((err) => {
          this.emit({ type: "config-error", message: describeError(err).message });
        });
        void this.autoPostResults().catch((err) => {
          this.emit({ type: "result-error", message: describeError(err).message });
        });
      },
    });
    this.watcher.start();
  }

  /** Look in on the sessions now rather than on the next tick. */
  async refreshStatuses(): Promise<void> {
    await this.watcher?.refresh();
  }

  /** The same, without waiting: for after a reply, where nobody is left to hear a failure. */
  private refreshStatusesSoon(): void {
    void this.refreshStatuses().catch((err) => {
      this.emit({ type: "status-error", message: describeError(err).message });
    });
  }

  /**
   * With postResults on auto, hand each new reply to one Slack window to
   * post. Only the page can post (it holds the Slack session), and only one
   * of them should, so the daemon picks the window rather than every window
   * racing to it.
   */
  private async autoPostResults(): Promise<void> {
    const config = await loadConfig();
    if (config.settings.postResults !== "auto") return;
    const history = await loadHistory();
    for (const [branch, status] of this.statuses) {
      if (!status.resultPending || status.resultMs === null) continue;
      const key = `${branch}\0${status.resultMs}`;
      if (this.autoPosted.has(key)) continue;
      const entry = [...history].reverse().find((h) => h.branch === branch);
      if (!entry?.permalink) continue;
      const result = await readResult(entry.worktreePath);
      if (!result) continue;
      const payload = JSON.stringify({
        branch,
        resultMs: status.resultMs,
        permalink: entry.permalink,
        label: entry.promptLabel,
        text: resultReply(result.text, { prUrl: status.pr?.url }),
      });
      for (const session of this.sessions.values()) {
        if (!session) continue;
        try {
          const res = (await session.send("Runtime.evaluate", {
            expression: `window.${POST_RESULT_FN} ? window.${POST_RESULT_FN}(${JSON.stringify(payload)}) : false`,
            returnByValue: true,
          })) as { result?: { value?: unknown } };
          if (res.result?.value === true) {
            this.autoPosted.add(key);
            break;
          }
        } catch {
          // That window is going away; try the next.
        }
      }
    }
  }

  /** Push fresh config to every attached window after a link changes. */
  async broadcastConfig(): Promise<void> {
    const config = pageConfig(await loadConfig(), await loadHistory(), this.statuses);
    const payload = JSON.stringify(JSON.stringify(config));
    for (const session of this.sessions.values()) {
      if (!session) continue;
      try {
        await session.send("Runtime.evaluate", {
          expression: `window.__sidequestSetConfig && window.__sidequestSetConfig(${payload})`,
        });
      } catch {
        // Window is going away; the poll loop re-attaches with the new prelude.
      }
    }
  }

  private async handleAsk(
    session: CdpSession,
    params: Record<string, unknown>,
  ): Promise<void> {
    let request: AskRequest;
    try {
      request = JSON.parse(String(params.payload)) as AskRequest;
    } catch {
      return;
    }

    const contextId = params.executionContextId as number | undefined;

    switch (request.op) {
      case "start-session":
        await this.handleStartSession(session, contextId, request);
        return;
      case "link-repo":
        await this.handleLinkRepo(session, contextId, request);
        return;
      case "channel-status":
        await this.handleChannelStatus(session, contextId, request);
        return;
      case "suggest-repos":
        await this.handleSuggestRepos(session, contextId, request);
        return;
      case "reopen":
        await this.handleReopen(session, contextId, request);
        return;
      case "get-result":
        await this.handleGetResult(session, contextId, request);
        return;
      case "result-posted":
        await this.handleResultPosted(session, contextId, request);
        return;
      case "list-sessions":
        await this.handleListSessions(session, contextId, request);
        return;
      case "remove-session":
        await this.handleRemoveSession(session, contextId, request);
        return;
      default:
        await this.reply(session, contextId, { id: request.id, error: `unknown op ${request.op}` });
    }
  }

  private async handleStartSession(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const promptKey = String(request.promptKey ?? "");
    if (!promptFor(await loadConfig(), promptKey)) {
      await this.reply(session, contextId, { id: request.id, error: "unknown prompt" });
      return;
    }

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

    try {
      const result = await createSession(promptKey, context);
      this.emit({
        type: "session",
        channel: context.channelName,
        prompt: promptKey,
        branch: result.branch,
      });
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
        });
        stats = computeStats(history);
      } catch (err) {
        this.emit({ type: "history-error", message: describeError(err).message });
      }
      await this.reply(session, contextId, {
        id: request.id,
        ok: true,
        branch: result.branch,
        worktree: result.worktreePath,
        repo: result.repoLabel,
        stats,
        // Posted by the overlay, which is signed in to Slack; empty means don't.
        reply: result.reply,
        // The overlay says so on the message rather than failing silently.
        warning: result.launchError,
        attachments: result.attachments,
      });
      await this.broadcastConfig();
      this.refreshStatusesSoon();
    } catch (err) {
      const { message, hint } = describeError(err);
      this.emit({ type: "session-error", channel: context.channelName, message });
      await this.reply(session, contextId, { id: request.id, error: message, hint });
    }
  }

  /**
   * Link the channel the reader is looking at to a repo. The page knows the
   * channel; the daemon owns the mapping and the filesystem, so it validates
   * the path and answers with what it actually stored.
   *
   * A path adds that repo to the channel's list (a channel can have several).
   * Otherwise `repo` names the one to unlink, and neither unlinks them all.
   */
  private async handleLinkRepo(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const key = channelKey(request.channel ?? "");
    if (!key) {
      await this.reply(session, contextId, { id: request.id, error: "no channel to link" });
      return;
    }

    const raw = (request.repoPath ?? "").trim();

    try {
      if (raw.length === 0) {
        const which = (request.repo ?? "").trim();
        const { removed, left } = await updateConfig((config) => {
          const removed = removeLink(config, key, which);
          return { removed, left: linksForChannel(config, key).map(linkLabel) };
        });
        if (which && removed.length === 0) {
          await this.reply(session, contextId, {
            id: request.id,
            error: `${which} is not linked to #${key}.`,
            repos: left,
          });
          await this.broadcastConfig();
          return;
        }
        for (const link of removed) this.emit({ type: "unlink", channel: key, message: link.repoPath });
        await this.reply(session, contextId, {
          id: request.id,
          ok: true,
          linked: left.length > 0,
          removed: removed.map(linkLabel),
          repos: left,
        });
      } else {
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
        this.emit({ type: "link", channel: key, message: repo.root });
        await this.reply(session, contextId, {
          id: request.id,
          ok: true,
          linked: true,
          repo: linkLabel(stored),
          repoPath: repo.root,
          repos: labels,
        });
      }
      await this.broadcastConfig();
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint });
    }
  }

  /** Repos worth offering for this channel, best match first. */
  private async handleSuggestRepos(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const config = await loadConfig();
      const channel = channelKey(request.channel ?? "");
      // Already on this channel is not a suggestion for it.
      const own = new Set(linksForChannel(config, channel).map((l) => l.repoPath));
      const found = await discoverRepos({
        channel,
        linkedRepos: linkedRepoPaths(config),
        worktreesRoot: config.settings.worktreesRoot,
        roots: config.settings.repoSearchRoots.length > 0
          ? config.settings.repoSearchRoots.map(expandPath)
          : undefined,
      });
      const repos = found.filter((r) => !own.has(r.path));
      await this.reply(session, contextId, { id: request.id, ok: true, repos });
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint, repos: [] });
    }
  }

  /**
   * Back into a session started earlier, from the mark on its message — by
   * branch — or from the sessions panel, by its worktree's name, which cannot
   * be mistaken for a same-named branch in another repo.
   */
  private async handleReopen(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const id = typeof request.session === "string" ? request.session.trim() : "";
      let branch = (request.branch ?? "").trim();
      const config = await loadConfig();
      const history = await loadHistory();
      const known = history.filter((h) => h.branch === branch).map((h) => h.repoPath);
      const found = id
        ? await findById(config, history, id)
        : branch ? await findSession(config, branch, known) : null;
      if (found) branch = found.worktree.branch;
      if (!found) {
        await this.reply(session, contextId, {
          id: request.id,
          error: `${branch || "That session"} is gone.`,
          hint: "It was probably cleaned up — start a new one from the menu.",
        });
        return;
      }
      await openSession(config, found);
      this.emit({ type: "reopen", branch });
      await this.reply(session, contextId, { id: request.id, ok: true, branch });
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint });
    }
  }

  /** A session's reply for the thread, ready to read, edit and post. */
  private async handleGetResult(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const branch = (request.branch ?? "").trim();
    try {
      const entry = (await loadHistory()).reverse().find((h) => h.branch === branch);
      const result = entry ? await readResult(entry.worktreePath) : null;
      if (!entry || !result) {
        await this.reply(session, contextId, { id: request.id, error: `${branch || "That session"} has no reply to post.` });
        return;
      }
      const status = this.statuses.get(branch);
      await this.reply(session, contextId, {
        id: request.id,
        ok: true,
        branch,
        label: entry.promptLabel,
        channel: entry.channel,
        permalink: entry.permalink ?? "",
        resultMs: result.mtimeMs,
        text: resultReply(result.text, { prUrl: status?.pr?.url }),
      });
    } catch (err) {
      // Unanswered, the overlay would sit on its spinner until it gives up.
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint });
    }
  }

  /**
   * The page posted a reply (or was told not to): remember which write of
   * result.md that was, so it is not offered again unless the agent rewrites it.
   */
  private async handleResultPosted(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const branch = (request.branch ?? "").trim();
    if (request.error) {
      this.emit({ type: "result-error", branch, message: request.error });
      await this.reply(session, contextId, { id: request.id, ok: true });
      return;
    }
    try {
      const resultMs = typeof request.resultMs === "number" ? request.resultMs : Date.now();
      await updateSession(branch, { resultPostedMs: resultMs });
      this.emit({ type: request.dismissed ? "result-dismissed" : "result-posted", branch });
      await this.reply(session, contextId, { id: request.id, ok: true });
      await this.refreshStatuses();
      await this.broadcastConfig();
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint });
    }
  }

  /**
   * The sessions panel's list. Asked for each time the panel opens, so it
   * says what git says now rather than what the config said at inject time.
   */
  private async handleListSessions(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const sessions = await listSessions(await loadConfig(), await loadHistory());
      await this.reply(session, contextId, { id: request.id, ok: true, sessions });
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint, sessions: [] });
    }
  }

  /**
   * Remove a finished session from the panel. Uncommitted work is refused
   * with how much of it there is, so the page can ask before sending `force`.
   */
  private async handleRemoveSession(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const result = await removeSession(await loadConfig(), await loadHistory(), request.session ?? "", {
        force: request.force === true,
      });
      this.emit({ type: "remove-session", branch: result.branch });
      await this.reply(session, contextId, { id: request.id, ok: true, ...result });
      // Its mark now says it was cleaned up.
      this.refreshStatusesSoon();
    } catch (err) {
      const { message, hint } = describeError(err);
      const dirty = err instanceof UncommittedWorkError ? err.dirty : undefined;
      await this.reply(session, contextId, { id: request.id, error: message, hint, dirty });
    }
  }

  private async handleChannelStatus(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const config = await loadConfig();
      const links = linksForChannel(config, request.channel ?? "");

      await this.reply(session, contextId, {
        id: request.id,
        linked: links.length > 0,
        repo: links[0] ? linkLabel(links[0]) : "",
        repoPath: links[0]?.repoPath ?? "",
        repos: links.map(linkLabel),
      });
    } catch (err) {
      // A config that does not parse lands here; the overlay should hear why
      // now rather than wait out its timeout.
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint, repos: [] });
    }
  }

  private async reply(
    session: CdpSession,
    contextId: number | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const expression = `window.${RESULT_FN} && window.${RESULT_FN}(${JSON.stringify(
      JSON.stringify(payload),
    )})`;
    try {
      await session.send("Runtime.evaluate", { expression, contextId });
    } catch {
      // The context can go away mid-flight (navigation, workspace switch).
      // Retry once against whatever the default context is now.
      try {
        await session.send("Runtime.evaluate", { expression });
      } catch {
        // The window is gone; there is nobody left to answer.
      }
    }
  }

  get attachedCount(): number {
    return [...this.sessions.values()].filter(Boolean).length;
  }

  /** What the last sweep found, for `start`'s status line and for doctor. */
  get lastSweep(): SweepSummary {
    return { ...this.sweepSummary };
  }
}

/** A one-line census of a DevTools endpoint, by target type. */
function describeTargets(targets: CdpTarget[]): string {
  if (targets.length === 0) return "the DevTools endpoint reports no targets at all";
  const byType = new Map<string, number>();
  for (const target of targets) {
    byType.set(target.type, (byType.get(target.type) ?? 0) + 1);
  }
  const census = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  return `the DevTools endpoint has ${census}, none of which looks like a Slack window`;
}
