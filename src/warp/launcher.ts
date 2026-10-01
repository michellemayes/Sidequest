import { access } from "node:fs/promises";
import { warpScheme } from "../util/platform.js";
import { openUri } from "../util/openUri.js";
import { log } from "../util/log.js";
import type { WarpStrategy } from "../config/schema.js";
import { writeLaunchConfig, writeTabConfig, type WarpColor, type WarpSessionSpec } from "./configFiles.js";

export interface LaunchOptions {
  spec: WarpSessionSpec;
  strategy: WarpStrategy;
  preview: boolean;
  /**
   * The session's `pending` marker. When it exists before launch, a strategy
   * only counts as working once the agent has claimed it; otherwise the next
   * strategy is tried.
   */
  pendingFile?: string;
  /** How long to wait for the agent to claim the marker per strategy. */
  claimTimeoutMs?: number;
  /** How long to give Warp's file watcher to notice a new tab config. */
  tabConfigSettleMs?: number;
  /**
   * A tab config already written for this spec (see prepareTabConfig), so
   * the settle time has partly or wholly passed by the time Warp is opened.
   */
  preparedTabConfig?: PreparedTabConfig;
}

export interface PreparedTabConfig {
  uri: string;
  writtenAt: number;
}

/**
 * Write the tab config ahead of launching, so Warp's file watcher can find it
 * while the worktree is still being checked out.
 */
export async function prepareTabConfig(spec: WarpSessionSpec, preview: boolean): Promise<PreparedTabConfig> {
  const uri = await buildUri({ spec, strategy: "tab_config", preview });
  return { uri, writtenAt: Date.now() };
}

export interface LaunchResult {
  /** The strategy that actually opened Warp, after any fallback. */
  strategy: ConcreteStrategy;
  uri: string;
  /** True when we fell back because the preferred strategy failed. */
  fellBack: boolean;
  /**
   * Whether the agent claimed the session's pending marker in time; null when
   * there was nothing to watch.
   */
  agentStarted: boolean | null;
}

/** A concrete way of opening Warp; `auto` resolves to these in order. */
export type ConcreteStrategy = Exclude<WarpStrategy, "auto">;

/**
 * Tab configs come first: Warp watches their directory and picks up a new one
 * without a restart. Launch configs are only read at startup, so they work
 * only when Warp was not already running.
 */
const ALL_STRATEGIES: ConcreteStrategy[] = ["tab_config", "launch_config", "new_tab"];

/** The strategies to try, preferred first. `new_tab` never falls back. */
export function strategyOrder(preferred: WarpStrategy): ConcreteStrategy[] {
  if (preferred === "auto") return [...ALL_STRATEGIES];
  if (preferred === "new_tab") return ["new_tab"];
  return [preferred, ...ALL_STRATEGIES.filter((s) => s !== preferred)];
}

/**
 * Open Warp on a prepared worktree.
 *
 * `tab_config` and `launch_config` give a coloured tab and ask Warp to
 * run the command itself. `new_tab` only sets the directory — the shell hook
 * starts the agent there. Strategies are tried in order with the preferred one
 * first; `auto` tries them in the order most likely to work.
 *
 * Handing a URI to the OS succeeds whether or not Warp acts on it: Warp reads
 * launch configurations at startup, so one written while it runs is unknown
 * to it and the deeplink just focuses the app (warpdotdev/Warp#3780), and it
 * has ignored `exec` commands from deeplinks in some versions
 * (warpdotdev/warp#9007). So when there is a pending marker to watch, a
 * strategy only counts once the agent has claimed it; otherwise the next one
 * is tried.
 */
export async function launchWarp(options: LaunchOptions): Promise<LaunchResult> {
  const { spec, preview } = options;
  const strategies = strategyOrder(options.strategy);
  const first = strategies[0]!;
  const watch = options.pendingFile && (await exists(options.pendingFile)) ? options.pendingFile : null;
  const timeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

  let lastError: unknown = null;
  let opened: { strategy: ConcreteStrategy; uri: string } | null = null;
  for (const [index, strategy] of strategies.entries()) {
    const isLast = index === strategies.length - 1;
    try {
      const prepared = strategy === "tab_config" ? options.preparedTabConfig : undefined;
      const uri = prepared?.uri ?? (await buildUri({ spec, strategy, preview }));
      if (strategy === "tab_config") {
        // Warp finds new tab configs with a file watcher; a deeplink that
        // arrives before it has looked resolves to nothing.
        const settleMs = options.tabConfigSettleMs ?? TAB_CONFIG_SETTLE_MS;
        const since = prepared ? Date.now() - prepared.writtenAt : 0;
        if (settleMs > since) await sleep(settleMs - since);
      }
      await openUri(uri, "Warp", "Is Warp installed and registered for the warp:// URI scheme?");
      opened = { strategy, uri };
      if (!watch) {
        return { strategy, uri, fellBack: strategy !== first, agentStarted: null };
      }
      const claimed = await waitForClaim(watch, timeoutMs);
      if (claimed || isLast) {
        return { strategy, uri, fellBack: strategy !== first, agentStarted: claimed };
      }
      log.warn(`${strategy} opened Warp but the agent did not start, trying the next strategy`);
    } catch (err) {
      lastError = err;
      log.warn(
        `${strategy} launch failed, trying the next strategy`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (opened) {
    return { ...opened, fellBack: opened.strategy !== first, agentStarted: false };
  }
  throw lastError;
}

export const CLAIM_TIMEOUT_MS = 6_000;
const CLAIM_POLL_MS = 50;
const TAB_CONFIG_SETTLE_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once the pending marker is gone, i.e. autorun.sh has claimed it. */
export async function waitForClaim(pendingFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await exists(pendingFile))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(CLAIM_POLL_MS);
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface BuildUriOptions {
  spec: WarpSessionSpec;
  strategy: ConcreteStrategy;
  preview: boolean;
}

async function buildUri(options: BuildUriOptions): Promise<string> {
  const { spec, strategy, preview } = options;
  const scheme = warpScheme(preview);

  switch (strategy) {
    case "launch_config": {
      const name = await writeLaunchConfig(spec, preview);
      return `${scheme}://launch/${encodeURIComponent(name)}`;
    }
    case "tab_config": {
      const name = await writeTabConfig(spec, preview);
      return `${scheme}://tab_config/${encodeURIComponent(name)}`;
    }
    case "new_tab":
      return newTabUri(spec.cwd, preview);
  }
}

function newTabUri(cwd: string, preview: boolean): string {
  return `${warpScheme(preview)}://action/new_tab?path=${encodeURIComponent(cwd)}`;
}

/** Tab colour per prompt, so sessions are distinguishable at a glance. */
export function colorForPrompt(key: string): WarpColor {
  switch (key) {
    case "investigate":
      return "blue";
    case "fix":
      return "yellow";
    case "review":
      return "magenta";
    case "ask":
      return "cyan";
    case "linear":
    case "github":
    case "jira":
      return "green";
    default:
      return "cyan";
  }
}
