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
import { channelKey } from "../config/channels.js";
import { loadConfig, updateConfig, expandPath } from "../config/store.js";
import { inspectRepo } from "../git/repo.js";
import { createSession, type MessageContext } from "../session/create.js";
import { computeStats, loadHistory, recordSession } from "../session/history.js";
import { findSession, openSession } from "../session/reopen.js";
import { discoverRepos } from "../git/discover.js";
import { PROMPT_KEYS, type PromptKey } from "../config/schema.js";
import { describeError } from "../util/errors.js";
import { log } from "../util/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/cdp -> dist -> project root. The overlay ships as plain JS, unbuilt,
// so it lives outside src/ and is read at inject time.
const INJECT_PATH = join(HERE, "..", "..", "client", "inject.js");

const BINDING = "__sidequestAsk";
const RESULT_FN = "__sidequestResult";
const POLL_MS = 4000;

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
  repoPath?: string;
  branch?: string;
}

export class Attacher {
  private readonly sessions = new Map<string, CdpSession | null>();
  private readonly targetUrl: RegExp;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sweepSummary: SweepSummary = { targets: 0, matched: 0 };
  /** So a window that never appears is said once, not every four seconds. */
  private reportedEmpty = false;

  constructor(
    private readonly options: {
      cdpPort: number;
      targetUrlPattern: string;
      onEvent?: (event: AttacherEvent) => void;
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
    const config = pageConfig(await loadConfig(), await loadHistory());
    return `window.__SIDEQUEST_CONFIG = ${JSON.stringify(config)};\n${script}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reportedEmpty = false;
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
    const session = new CdpSession(target.webSocketDebuggerUrl!);
    await session.connect();

    session.on(CLOSE_EVENT, () => {
      this.sessions.delete(target.id);
      // A shutdown closes every socket itself; that is not a window going away.
      if (!this.stopped) this.emit({ type: "detached", target: target.url });
    });

    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", { name: BINDING });

    session.on("Runtime.bindingCalled", (params) => {
      if (params.name !== BINDING) return;
      void this.handleAsk(session, params).catch((err) => {
        this.emit({ type: "ask-error", message: describeError(err).message });
      });
    });

    const source = await this.source();
    // Covers navigations and workspace switches...
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
    // ...and the window that is already open right now.
    await session.send("Runtime.evaluate", { expression: source, awaitPromise: false });

    this.emit({ type: "attached", target: target.url });
    return session;
  }

  /** Push fresh config to every attached window after a link changes. */
  async broadcastConfig(): Promise<void> {
    const config = pageConfig(await loadConfig(), await loadHistory());
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
      default:
        await this.reply(session, contextId, { id: request.id, error: `unknown op ${request.op}` });
    }
  }

  private async handleStartSession(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const promptKey = request.promptKey as PromptKey;
    if (!PROMPT_KEYS.includes(promptKey)) {
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
        // The overlay says so on the message rather than failing silently.
        warning: result.launchError,
      });
      await this.broadcastConfig();
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
        await updateConfig((config) => {
          delete config.channels[key];
        });
        this.emit({ type: "unlink", channel: key });
        await this.reply(session, contextId, { id: request.id, ok: true, linked: false });
      } else {
        const repo = await inspectRepo(expandPath(raw));
        await updateConfig((config) => {
          config.channels[key] = {
            repoPath: repo.root,
            channel: key,
            baseBranch: "",
            label: "",
            linkedBy: "overlay",
            linkedAt: new Date().toISOString(),
          };
        });
        this.emit({ type: "link", channel: key, message: repo.root });
        await this.reply(session, contextId, {
          id: request.id,
          ok: true,
          linked: true,
          repo: repo.name,
          repoPath: repo.root,
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
      const repos = await discoverRepos({
        channel: channelKey(request.channel ?? ""),
        linkedRepos: [...new Set(Object.values(config.channels).map((l) => l.repoPath))],
        worktreesRoot: config.settings.worktreesRoot,
        roots: config.settings.repoSearchRoots.length > 0
          ? config.settings.repoSearchRoots.map(expandPath)
          : undefined,
      });
      await this.reply(session, contextId, { id: request.id, ok: true, repos });
    } catch (err) {
      const { message, hint } = describeError(err);
      await this.reply(session, contextId, { id: request.id, error: message, hint, repos: [] });
    }
  }

  /** Back into a session started earlier, from the mark on its message. */
  private async handleReopen(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    try {
      const branch = (request.branch ?? "").trim();
      const config = await loadConfig();
      const history = await loadHistory();
      const known = history.filter((h) => h.branch === branch).map((h) => h.repoPath);
      const found = branch ? await findSession(config, branch, known) : null;
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

  private async handleChannelStatus(
    session: CdpSession,
    contextId: number | undefined,
    request: AskRequest,
  ): Promise<void> {
    const key = channelKey(request.channel ?? "");
    const config = await loadConfig();
    const link = key ? config.channels[key] : undefined;

    await this.reply(session, contextId, {
      id: request.id,
      linked: Boolean(link),
      repo: link ? link.label.trim() || basename(link.repoPath) : "",
      repoPath: link?.repoPath ?? "",
    });
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

function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
