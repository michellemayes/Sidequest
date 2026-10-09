/**
 * What the Mac app can ask the daemon over the control socket.
 *
 * Most of it is what the overlay already asks (reopen, open a pull request,
 * follow up, link a repo…), answered by the same handlers in requests.ts.
 * The rest is what only an app needs: the whole session list with each one's
 * status, the config to edit, doctor's checks, and replies posted through a
 * Slack window rather than from one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DEFINITIONS, resolveAgent } from "../agents/agents.js";
import type { SweepSummary } from "../cdp/attacher.js";
import { inspectDebugPort, isSlackRunning, launchSlack } from "../cdp/launch.js";
import type { AskRequest } from "../cdp/requests.js";
import { sessionReply } from "../cdp/requests.js";
import { channelKey } from "../config/channels.js";
import { configSchema, PROMPT_KEYS, type Config } from "../config/schema.js";
import { allPrompts, loadConfig, updateConfig } from "../config/store.js";
import { runChecks } from "../cli/doctor.js";
import { cleanSweepOptions, sweepWorktrees } from "../session/cleanup.js";
import { computeStats, loadHistory, type HistoryEntry } from "../session/history.js";
import { readResult } from "../session/result.js";
import type { SessionStatus } from "../session/status.js";
import { TERMINAL_DEFINITIONS } from "../terminals/registry.js";
import { builtCommit, installRoot } from "../update.js";
import { UserFacingError } from "../util/errors.js";
import type { ControlConnection, ControlRequest } from "./server.js";

/** Bumped when a reply or event changes shape in a way an older app would misread. */
export const PROTOCOL_VERSION = 1;

/** Sessions the app lists, newest first. The watcher follows two weeks; this is more than that usually holds. */
const APP_SESSION_LIMIT = 200;
const TITLE_MAX = 120;

/** What the app's handlers need from the running daemon. The Attacher is one. */
export interface AppHost {
  ask(request: AskRequest): Promise<Record<string, unknown>>;
  postReply(job: { branch: string; resultMs: number; permalink: string; label: string; text: string }): Promise<boolean>;
  readonly statusSnapshot: Map<string, SessionStatus>;
  readonly attachedCount: number;
  readonly lastSweep: SweepSummary;
  sweepNow(): Promise<void>;
  broadcastConfig(): Promise<void>;
}

/** One session as the app shows it: who asked for what, and where it has got to. */
export interface AppSession {
  /** The worktree's directory name, as the sessions panel names a session. */
  id: string;
  branch: string;
  /** The Slack message's first line, or the prompt and branch for sessions recorded before messages were. */
  title: string;
  message: string;
  author: string;
  channel: string;
  repo: string;
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  promptKey: string;
  promptLabel: string;
  agent: string;
  agentId: string;
  createdAt: string;
  permalink: string;
  /** "unknown" for a session the watcher is not following (too old, or tracking is off). */
  state: SessionStatus["state"] | "unknown";
  commits: number;
  dirty: boolean;
  pr: SessionStatus["pr"];
  resultMs: number | null;
  resultPending: boolean;
  exitCode: number | null;
  /** A reply waiting for you, or a run that failed. */
  needsYou: boolean;
}

/** Slack's link markup, `<url|text>` and `<url>`, as the text a reader sees. */
function plainSlack(text: string): string {
  return text
    .replace(/<(?:[^|>]+)\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/[*_~`]/g, "");
}

export function sessionTitle(entry: HistoryEntry): string {
  const line = plainSlack(entry.message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const title = line ?? `${entry.promptLabel || "Session"} · ${entry.branch}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/** Every recent session, newest first, once per worktree, with the watcher's view of each. */
export function appSessions(
  history: HistoryEntry[],
  statuses: Map<string, SessionStatus>,
  options: { postResults: Config["settings"]["postResults"]; limit?: number },
): AppSession[] {
  const seen = new Set<string>();
  const out: AppSession[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < (options.limit ?? APP_SESSION_LIMIT); i -= 1) {
    const entry = history[i]!;
    const key = entry.worktreePath || entry.branch;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = statuses.get(entry.branch);
    const resultPending = Boolean(status?.resultPending) && options.postResults === "ask";
    out.push({
      id: entry.worktreePath ? entry.worktreePath.split("/").pop() ?? entry.branch : entry.branch,
      branch: entry.branch,
      title: sessionTitle(entry),
      message: entry.message ?? "",
      author: entry.author ?? "",
      channel: entry.channel,
      repo: entry.repoLabel,
      repoPath: entry.repoPath,
      worktreePath: entry.worktreePath,
      baseBranch: entry.baseBranch ?? "",
      promptKey: entry.promptKey,
      promptLabel: entry.promptLabel,
      agent: entry.agentLabel ?? "",
      agentId: entry.agentId ?? "",
      createdAt: entry.createdAt,
      permalink: entry.permalink ?? "",
      state: status?.state ?? "unknown",
      commits: status?.commits ?? 0,
      dirty: status?.dirty ?? false,
      pr: status?.pr ?? null,
      resultMs: status?.resultMs ?? null,
      resultPending,
      exitCode: status?.exitCode ?? null,
      needsYou: resultPending || status?.state === "failed",
    });
  }
  return out;
}

/** The ops the overlay also has, answered by its handlers unchanged. */
const SHARED_OPS = new Set([
  "reopen",
  "get-result",
  "open-pr",
  "follow-up",
  "remove-session",
  "link-repo",
  "suggest-repos",
  "list-sessions",
]);

async function packageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(installRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "";
  } catch {
    return "";
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The config as the app edits it, with every prompt as it stands and the choices the pickers offer. */
async function configReply(): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  return {
    ok: true,
    config,
    prompts: allPromptsWithHidden(config),
    agents: AGENT_DEFINITIONS.map((d) => ({
      id: d.id,
      label: d.label,
      host: d.host,
      headless: d.headless !== undefined,
      app: d.app !== undefined,
    })),
    terminals: TERMINAL_DEFINITIONS.map((t) => ({ id: t.id, label: t.label, summary: t.summary })),
  };
}

/** allPrompts leaves hidden ones out of the menu; the app shows them so they can be shown again. */
function allPromptsWithHidden(config: Config): Array<{ key: string; hidden: boolean; builtIn: boolean; prompt: unknown }> {
  const unhidden: Config = { ...config, prompts: Object.fromEntries(
    Object.entries(config.prompts).map(([k, v]) => [k, { ...v, hidden: false }]),
  ) };
  return allPrompts(unhidden).map(({ key, prompt }) => ({
    key,
    prompt,
    hidden: config.prompts[key]?.hidden === true,
    builtIn: (PROMPT_KEYS as readonly string[]).includes(key),
  }));
}

/**
 * Change settings and prompts. `settings` is merged over what is there;
 * `prompts` sets each named override, and null removes one (back to the
 * built-in, or a prompt of your own deleted). The result has to pass the
 * same schema the config file does, or nothing is written.
 */
async function setConfig(request: ControlRequest): Promise<void> {
  const settings = request.settings && typeof request.settings === "object" ? request.settings : {};
  const prompts = request.prompts && typeof request.prompts === "object" ? (request.prompts as Record<string, unknown>) : {};
  await updateConfig((config) => {
    const nextPrompts: Record<string, unknown> = { ...config.prompts };
    for (const [key, value] of Object.entries(prompts)) {
      if (value === null) delete nextPrompts[key];
      else nextPrompts[key] = value;
    }
    const parsed = configSchema.safeParse({
      ...config,
      settings: { ...config.settings, ...settings },
      prompts: nextPrompts,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UserFacingError(
        `That setting can't be saved: ${issue?.path.join(".") || "config"} ${issue?.message ?? "is not valid"}.`,
      );
    }
    Object.assign(config, parsed.data);
  });
}

/** Change a channel's link to one repo: its base branch, label, or which repo is the default. */
async function setLink(request: ControlRequest): Promise<void> {
  const key = channelKey(str(request.channel));
  const repoPath = str(request.repoPath);
  await updateConfig((config) => {
    const links = config.channels[key];
    const link = links?.find((l) => l.repoPath === repoPath);
    if (!links || !link) throw new UserFacingError(`${repoPath || "That repo"} is not linked to #${key}.`);
    if (typeof request.baseBranch === "string") link.baseBranch = request.baseBranch.trim();
    if (typeof request.label === "string") link.label = request.label.trim();
    if (request.makeDefault === true) {
      config.channels[key] = [link, ...links.filter((l) => l !== link)];
    }
  });
}

async function health(host: AppHost): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  const { cdpPort, targetUrlPattern, terminal } = config.settings;
  const [port, slackRunning] = await Promise.all([inspectDebugPort(cdpPort, targetUrlPattern), isSlackRunning()]);
  const agent = resolveAgent(config.settings.agent, config.settings);
  return {
    ok: true,
    attached: host.attachedCount,
    slackRunning,
    debugPort: { port: cdpPort, open: port.open, isSlack: port.isSlack, matching: port.matchingTargets },
    agent: { id: agent.id, label: agent.label, host: agent.host },
    terminal,
    pid: process.pid,
  };
}

/** Answer one request from the app. */
export function createAppHandler(
  host: AppHost,
  hooks: { onSubscribe?: (connection: ControlConnection) => void } = {},
) {
  return async (request: ControlRequest, connection: ControlConnection): Promise<Record<string, unknown>> => {
    const op = request.op;
    if (SHARED_OPS.has(op)) return host.ask(request as unknown as AskRequest);

    switch (op) {
      case "hello":
        return {
          ok: true,
          protocol: PROTOCOL_VERSION,
          version: await packageVersion(),
          build: (await builtCommit(installRoot())) ?? "",
        };
      case "subscribe":
        connection.subscribed = true;
        connection.takesNotices = request.notices === true;
        hooks.onSubscribe?.(connection);
        return { ok: true };
      case "health":
        return health(host);
      case "sessions": {
        const config = await loadConfig();
        const history = await loadHistory();
        return {
          ok: true,
          sessions: appSessions(history, host.statusSnapshot, { postResults: config.settings.postResults }),
          stats: computeStats(history),
        };
      }
      case "get-config":
        return configReply();
      case "set-config":
        await setConfig(request);
        await host.broadcastConfig();
        return configReply();
      case "set-link":
        await setLink(request);
        await host.broadcastConfig();
        return configReply();
      case "doctor":
        return { ok: true, rows: await runChecks(await loadConfig()) };
      case "clean": {
        const outcomes = await sweepWorktrees(
          await loadConfig(),
          cleanSweepOptions({ force: false, all: false, recent: request.recent === true }),
        );
        return {
          ok: true,
          removed: outcomes.filter((o) => o.kind === "removed").length,
          kept: outcomes.filter((o) => o.kind === "not-merged" || o.kind === "dirty" || o.kind === "recent").length,
          outcomes,
        };
      }
      case "post-reply": {
        const branch = str(request.branch);
        const entry = [...(await loadHistory())].reverse().find((h) => h.branch === branch);
        if (!entry?.permalink) throw new UserFacingError(`${branch || "That session"} has no Slack message to reply to.`);
        const result = await readResult(entry.worktreePath);
        const status = host.statusSnapshot.get(branch);
        const edited = typeof request.text === "string" && request.text.trim() ? request.text : null;
        const config = await loadConfig();
        const text = edited ?? (result ? sessionReply(entry, result.text, status?.pr?.url, config) : "");
        if (!text) throw new UserFacingError(`${branch} has no reply to post.`);
        const posted = await host.postReply({
          branch,
          resultMs: result?.mtimeMs ?? status?.resultMs ?? Date.now(),
          permalink: entry.permalink,
          label: entry.promptLabel,
          text,
        });
        if (!posted) {
          throw new UserFacingError("No Slack window is open to post from.", "Open Slack, then try again.");
        }
        return { ok: true, branch };
      }
      case "dismiss-reply": {
        const branch = str(request.branch);
        const status = host.statusSnapshot.get(branch);
        return host.ask({
          id: String(request.id),
          op: "result-posted",
          branch,
          resultMs: status?.resultMs ?? Date.now(),
          dismissed: true,
        });
      }
      case "restart-slack": {
        const { cdpPort, targetUrlPattern } = (await loadConfig()).settings;
        await launchSlack({ cdpPort, targetUrlPattern, force: true });
        await host.sweepNow();
        return { ok: true };
      }
      default:
        return { error: `unknown op ${op}` };
    }
  };
}
