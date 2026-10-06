import { stat } from "node:fs/promises";
import type { CdpSession } from "./client.js";
import type { AttacherEvent } from "./requests.js";
import { configFile } from "../config/paths.js";
import { loadConfig } from "../config/store.js";
import { syncConfig } from "../config/sync.js";
import { describeError } from "../util/errors.js";

/**
 * How often to look for changes another computer made. Your own changes go
 * out within a poll of being made; this is only how long theirs take to
 * arrive, and each look is four small calls to Slack's API.
 */
const SYNC_INTERVAL_MS = 2 * 60_000;
/** A page call goes to Slack and back a few times. */
const PAGE_TIMEOUT_MS = 30_000;

interface SyncRead {
  ok: boolean;
  error?: string;
  channel?: string;
  note?: { ts: string; text: string; pinned: boolean } | null;
  stale?: string[];
}

/**
 * Runs settings sync from the daemon (see src/config/sync.ts): when it is
 * on, every so often and soon after the config changes, it has one Slack
 * window read the note, merges it here, and has the same window write back
 * whatever Slack is missing.
 */
export class SettingsSyncer {
  private running = false;
  private lastRun = 0;
  private lastMtime = -1;
  private lastError = "";

  constructor(
    private readonly options: {
      sessions: () => CdpSession[];
      emit: (event: AttacherEvent) => void;
      /** The config took changes from Slack: tell the windows. */
      onPulled: () => Promise<void>;
      intervalMs?: number;
    },
  ) {}

  /** Called on every poll. Does nothing unless sync is on and a round is due; never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.maybeRun();
    } catch (err) {
      this.report(describeError(err).message);
    } finally {
      this.running = false;
    }
  }

  private async maybeRun(): Promise<void> {
    let enabled: boolean;
    try {
      enabled = (await loadConfig()).settings.sync;
    } catch {
      // A config that does not parse is reported elsewhere, and is nothing to sync.
      return;
    }
    if (!enabled) {
      // So turning it on syncs at once.
      this.lastRun = 0;
      return;
    }
    const mtime = await configMtime();
    const due = Date.now() - this.lastRun >= (this.options.intervalMs ?? SYNC_INTERVAL_MS);
    if (!due && mtime === this.lastMtime) return;
    const sessions = this.options.sessions();
    if (sessions.length === 0) return;

    this.lastRun = Date.now();
    try {
      await this.run(sessions);
    } finally {
      // After the round, so its own write is not taken for a change to send.
      this.lastMtime = await configMtime();
    }
  }

  private async run(sessions: CdpSession[]): Promise<void> {
    let read: SyncRead | null = null;
    let window: CdpSession | null = null;
    let failure = "";
    for (const session of sessions) {
      const res = (await callPage(session, "window.__sidequestSyncRead ? window.__sidequestSyncRead() : null")
        .catch(() => null)) as SyncRead | null;
      if (res?.ok && res.channel) {
        read = res;
        window = session;
        break;
      }
      if (res?.error) failure = res.error;
    }
    if (!read || !window) {
      // No window has the overlay yet: try again on the next poll.
      this.lastRun = 0;
      if (failure) throw new Error(`could not read the settings note from Slack: ${failure}`);
      return;
    }

    const plan = await syncConfig(read.note?.text ?? null);
    if (plan.pulled) {
      this.options.emit({
        type: "sync",
        message: `took settings from Slack${plan.from ? ` (last changed on ${plan.from})` : ""}`,
      });
      await this.options.onPulled();
    }
    if (plan.push !== null) {
      const job = JSON.stringify({
        channel: read.channel,
        ts: read.note?.ts ?? "",
        pinned: read.note?.pinned ?? false,
        stale: read.stale ?? [],
        text: plan.push,
      });
      const res = (await callPage(
        window,
        `window.__sidequestSyncWrite(${JSON.stringify(job)})`,
      )) as { ok?: boolean; error?: string } | null;
      if (!res?.ok) throw new Error(`could not save the settings note in Slack: ${res?.error ?? "no answer"}`);
      await plan.commit();
      this.options.emit({
        type: "sync",
        message: plan.replacedInvalid
          ? "the settings note in Slack did not read, so it was rewritten from this computer's settings"
          : read.note ? "saved settings to Slack" : "started syncing settings through Slack",
      });
    }
    this.lastError = "";
  }

  /** Each problem once, not every round it persists. */
  private report(message: string): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.options.emit({ type: "sync-error", message });
  }
}

async function configMtime(): Promise<number> {
  try {
    return (await stat(configFile())).mtimeMs;
  } catch {
    return 0;
  }
}

async function callPage(session: CdpSession, expression: string): Promise<unknown> {
  const res = (await session.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    PAGE_TIMEOUT_MS,
  )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (res.exceptionDetails) throw new Error("the page threw");
  return res.result?.value ?? null;
}
