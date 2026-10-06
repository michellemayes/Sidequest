import { CdpSession, CLOSE_EVENT, isAttachableTarget, listTargets, type CdpTarget } from "./client.js";
import { overlaySource } from "./overlay.js";
import { answer, sessionReply, type AskRequest, type AttacherEvent, type RequestHost } from "./requests.js";
import { SettingsSyncer } from "./syncer.js";
import { pageConfig } from "../config/pageConfig.js";
import { loadConfig } from "../config/store.js";
import { loadHistory, updateSession, type HistoryEntry } from "../session/history.js";
import { readResult } from "../session/result.js";
import { StatusWatcher, type SessionStatus } from "../session/status.js";
import { noticesFor, showNotice } from "../session/notices.js";
import { describeError } from "../util/errors.js";

export type { AttacherEvent } from "./requests.js";

const BINDING = "__sidequestAsk";
const RESULT_FN = "__sidequestResult";
const POST_RESULT_FN = "__sidequestPostResult";
const REACT_FN = "__sidequestReact";
/** The reaction a session's message gets for how it ended, by the state that says so. */
const OUTCOME_REACTIONS: Partial<Record<SessionStatus["state"], string>> = {
  merged: "white_check_mark",
  failed: "x",
};
const POLL_MS = 4000;
/** As long as the overlay keeps a message's line (RESULT_TTL_MS in client/overlay/config.js). */
const LAUNCH_ERROR_TTL_MS = 10 * 60 * 1000;
/** How long a window gets to say whether it will post a reply; see autoPostResults. */
const AUTO_POST_TIMEOUT_MS = 3_000;

/** What the most recent sweep saw on the DevTools endpoint. */
export interface SweepSummary {
  /** Every target the endpoint reported, of any type. */
  targets: number;
  /** Those that look like a Slack window. */
  matched: number;
}

export class Attacher {
  private readonly sessions = new Map<string, CdpSession | null>();
  private readonly targetUrl: RegExp;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Settings sync through Slack, when settings.sync is on. */
  private readonly syncer: SettingsSyncer;
  private sweepSummary: SweepSummary = { targets: 0, matched: 0 };
  /** So a window that never appears is said once, not every four seconds. */
  private reportedEmpty = false;
  /** Follows the recent sessions, for the marks on their messages and their replies. */
  private watcher: StatusWatcher | null = null;
  private statuses = new Map<string, SessionStatus>();
  /** Results already handed to a window to post, as branch + mtime, so each is posted once. */
  private readonly autoPosted = new Set<string>();
  /** The outcome reaction each session's message has been handed, so each is asked for once. */
  private readonly reacted = new Map<string, string>();
  /**
   * Agents that did not start in a terminal that did open, by branch: found
   * after the overlay was told the session started, so it hears through the
   * config instead. Kept for as long as the overlay keeps a message's line.
   */
  private readonly launchErrors = new Map<string, { message: string; at: number }>();
  /** Sessions being started right now, so a shutdown can let them finish. */
  private startsInFlight = 0;
  /** Set once a shutdown has begun: new sessions are turned away. */
  private draining = false;

  constructor(
    private readonly options: {
      cdpPort: number;
      targetUrlPattern: string;
      onEvent?: (event: AttacherEvent) => void;
      /** How often to look in on sessions; false to not follow them at all. */
      watchIntervalMs?: number | false;
      /** How often settings sync looks for changes from other computers. */
      syncIntervalMs?: number;
    },
  ) {
    this.targetUrl = new RegExp(options.targetUrlPattern, "i");
    this.syncer = new SettingsSyncer({
      sessions: () => [...this.sessions.values()].filter((s): s is CdpSession => s !== null),
      emit: (event) => this.emit(event),
      onPulled: () => this.broadcastConfig(),
      intervalMs: options.syncIntervalMs,
    });
  }

  private emit(event: AttacherEvent): void {
    this.options.onEvent?.(event);
  }

  private readonly host: RequestHost = {
    emit: (event) => this.emit(event),
    broadcastConfig: () => this.broadcastConfig(),
    refreshStatuses: () => this.refreshStatuses(),
    followAgentCheck: (branch, channel, check) => this.followAgentCheck(branch, channel, check),
    status: (branch) => this.statuses.get(branch),
  };

  private async pageConfig(): Promise<ReturnType<typeof pageConfig>> {
    return pageConfig(await loadConfig(), await loadHistory(), this.statuses, this.currentLaunchErrors());
  }

  private async source(): Promise<string> {
    return `window.__SIDEQUEST_CONFIG = ${JSON.stringify(await this.pageConfig())};\n${overlaySource()}`;
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
      // Not awaited: a round goes to Slack and back, and the poll should not wait on it.
      if (!this.stopped) void this.syncer.tick();
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

  /**
   * Stop taking new sessions and wait, up to `timeoutMs`, for the ones being
   * started to answer. True when none were left.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.startsInFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.startsInFlight === 0;
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
        // An outcome the watcher saw before any window could react to it
        // would otherwise wait for the session's next change.
        void this.reactToOutcomes().catch((err) => {
          this.emit({ type: "reaction-error", message: describeError(err).message });
        });
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

      // The script below is registered once, with the config as it was at
      // attach time, so a window reloaded since (Cmd-R, a workspace switch)
      // would boot its overlay on that. The overlay is installed before the
      // page's own scripts, so by DOMContentLoaded (a main-frame event) it is
      // there to be handed the config as it is now.
      session.on("Page.domContentEventFired", () => {
        void this.pushConfig([session]);
      });

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
    // Sessions already somewhere when the daemon starts are not news.
    const since = Date.now();
    this.watcher = new StatusWatcher({
      intervalMs: this.options.watchIntervalMs ?? 15_000,
      pullRequests: settings.trackStatus,
      history: loadHistory,
      onChange: (statuses) => {
        const before = this.statuses;
        this.statuses = statuses;
        void this.announce(before, statuses, since).catch((err) => {
          this.emit({ type: "notify-error", message: describeError(err).message });
        });
        // A config edited into something that does not parse makes this
        // throw; say so, as the other background work does, rather than let
        // the rejection take the daemon down.
        void this.broadcastConfig().catch((err) => {
          this.emit({ type: "config-error", message: describeError(err).message });
        });
        void this.autoPostResults().catch((err) => {
          this.emit({ type: "result-error", message: describeError(err).message });
        });
        void this.reactToOutcomes().catch((err) => {
          this.emit({ type: "reaction-error", message: describeError(err).message });
        });
      },
    });
    this.watcher.start();
  }

  /** A desktop notification for each session that has moved on in a way worth stopping for. */
  private async announce(
    before: Map<string, SessionStatus>,
    after: Map<string, SessionStatus>,
    since: number,
  ): Promise<void> {
    const { settings } = await loadConfig();
    if (!settings.notify) return;
    const notices = noticesFor(before, after, await loadHistory(), { postResults: settings.postResults, since });
    for (const notice of notices) await showNotice(notice);
  }

  /** Look in on the sessions now rather than on the next tick. */
  async refreshStatuses(): Promise<void> {
    await this.watcher?.refresh();
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
        text: sessionReply(entry, result.text, status.pr?.url, config),
      });
      if (await this.handToOneWindow(POST_RESULT_FN, payload)) this.autoPosted.add(key);
    }
  }

  /**
   * Have one Slack window do something only a page can, as you: the first
   * whose `fn` takes the job on (answers true) does it. One at a time,
   * unlike the broadcast, since asking them all at once could do it twice.
   * The short timeout keeps a hung window from holding up the rest for
   * long; the page answers at once, before it calls Slack.
   */
  private async handToOneWindow(fn: string, payload: string): Promise<boolean> {
    for (const session of this.sessions.values()) {
      if (!session) continue;
      try {
        const res = (await session.send(
          "Runtime.evaluate",
          {
            expression: `window.${fn} ? window.${fn}(${JSON.stringify(payload)}) : false`,
            returnByValue: true,
          },
          AUTO_POST_TIMEOUT_MS,
        )) as { result?: { value?: unknown } };
        if (res.result?.value === true) return true;
      } catch {
        // That window is going away; try the next.
      }
    }
    return false;
  }

  /**
   * With settings.reactions on, swap the 👀 a session put on its message
   * for how it ended, once: ✅ when its pull request merged, ❌ when a
   * headless run failed. A reply posted from Slack gets its ✅ from the page
   * that posted it.
   */
  private async reactToOutcomes(): Promise<void> {
    const config = await loadConfig();
    if (!config.settings.reactions) return;
    let history: HistoryEntry[] | null = null;
    for (const [branch, status] of this.statuses) {
      const name = OUTCOME_REACTIONS[status.state];
      if (!name || this.reacted.get(branch) === name) continue;
      history ??= await loadHistory();
      const entry = [...history].reverse().find((h) => h.branch === branch);
      if (!entry?.permalink) continue;
      if (entry.reacted === name) {
        this.reacted.set(branch, name);
        continue;
      }
      const payload = JSON.stringify({ permalink: entry.permalink, name, remove: "eyes" });
      if (!(await this.handToOneWindow(REACT_FN, payload))) continue;
      this.reacted.set(branch, name);
      await updateSession(branch, { reacted: name });
    }
  }

  private currentLaunchErrors(): Map<string, string> {
    const out = new Map<string, string>();
    const cutoff = Date.now() - LAUNCH_ERROR_TTL_MS;
    for (const [branch, { message, at }] of this.launchErrors) {
      if (at < cutoff) this.launchErrors.delete(branch);
      else out.set(branch, message);
    }
    return out;
  }

  /**
   * The overlay has already been told the session started; if the agent then
   * does not, say so through the config, which the overlay shows on the
   * message's line the way it shows a launch error in the reply.
   */
  followAgentCheck(branch: string, channel: string, check: Promise<string | null>): void {
    void check.then(async (message) => {
      if (!message) return;
      this.emit({ type: "agent-not-started", channel, branch, message });
      this.launchErrors.set(branch, { message, at: Date.now() });
      await this.broadcastConfig();
    });
  }

  /** Push fresh config to every attached window after a link changes. */
  async broadcastConfig(): Promise<void> {
    await this.pushConfig([...this.sessions.values()]);
  }

  private async pushConfig(sessions: Array<CdpSession | null>): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(JSON.stringify(await this.pageConfig()));
    } catch (err) {
      this.emit({ type: "config-error", message: describeError(err).message });
      return;
    }
    // All at once, so one window that does not answer holds up none of the
    // others. One that fails is going away; the poll loop re-attaches it.
    await Promise.allSettled(
      sessions.map((session) =>
        session?.send("Runtime.evaluate", {
          expression: `window.__sidequestSetConfig && window.__sidequestSetConfig(${payload})`,
        }),
      ),
    );
  }

  private async handleAsk(session: CdpSession, params: Record<string, unknown>): Promise<void> {
    let request: AskRequest;
    try {
      request = JSON.parse(String(params.payload)) as AskRequest;
    } catch {
      return;
    }
    const contextId = params.executionContextId as number | undefined;

    if (request.op !== "start-session") {
      const { reply, after } = await answer(request, this.host);
      await this.reply(session, contextId, { id: request.id, ...reply });
      await after?.();
      return;
    }

    if (this.draining) {
      await this.reply(session, contextId, {
        id: request.id,
        error: "Sidequest is stopping.",
        hint: "Run `sidequest start` and try again.",
      });
      return;
    }
    // Counted until the page has its answer, so a shutdown does not cut a
    // session off between its worktree and its reply.
    this.startsInFlight += 1;
    let after: (() => Promise<void>) | undefined;
    try {
      const answered = await answer(request, this.host);
      after = answered.after;
      await this.reply(session, contextId, { id: request.id, ...answered.reply });
    } finally {
      this.startsInFlight -= 1;
    }
    await after?.();
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
