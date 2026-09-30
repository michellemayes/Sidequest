import { access } from "node:fs/promises";
import { run, CommandError } from "../util/exec.js";
import { uriOpener, warpScheme, platform } from "../util/platform.js";
import { UserFacingError } from "../util/errors.js";
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
}

export interface LaunchResult {
  /** The strategy that actually opened Warp, after any fallback. */
  strategy: WarpStrategy;
  uri: string;
  /** True when we fell back because the preferred strategy failed. */
  fellBack: boolean;
  /**
   * Whether the agent claimed the session's pending marker in time; null when
   * there was nothing to watch.
   */
  agentStarted: boolean | null;
}

const ALL_STRATEGIES: WarpStrategy[] = ["launch_config", "tab_config", "new_tab"];

/**
 * Open Warp on a prepared worktree.
 *
 * `launch_config` and `tab_config` give a titled, coloured tab and ask Warp to
 * run the command itself. `new_tab` only sets the directory — the shell hook
 * starts the agent there. Strategies are tried in order with the preferred one
 * first.
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
  const strategies =
    options.strategy === "new_tab"
      ? ALL_STRATEGIES.slice(2)
      : [options.strategy, ...ALL_STRATEGIES.filter((s) => s !== options.strategy)];
  const watch = options.pendingFile && (await exists(options.pendingFile)) ? options.pendingFile : null;
  const timeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

  let lastError: unknown = null;
  let opened: { strategy: WarpStrategy; uri: string } | null = null;
  for (const [index, strategy] of strategies.entries()) {
    const isLast = index === strategies.length - 1;
    try {
      const uri = await buildUri({ spec, strategy, preview });
      await openUri(uri);
      opened = { strategy, uri };
      if (!watch) {
        return { strategy, uri, fellBack: strategy !== options.strategy, agentStarted: null };
      }
      const claimed = await waitForClaim(watch, timeoutMs);
      if (claimed || isLast) {
        return { strategy, uri, fellBack: strategy !== options.strategy, agentStarted: claimed };
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
    return { ...opened, fellBack: opened.strategy !== options.strategy, agentStarted: false };
  }
  throw lastError;
}

const CLAIM_TIMEOUT_MS = 6_000;
const CLAIM_POLL_MS = 200;

/** True once the pending marker is gone, i.e. autorun.sh has claimed it. */
async function waitForClaim(pendingFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await exists(pendingFile))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface BuildUriOptions {
  spec: WarpSessionSpec;
  strategy: WarpStrategy;
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

async function openUri(uri: string): Promise<void> {
  const opener = uriOpener();
  if (!opener) {
    throw new UserFacingError(
      `sidequest does not know how to open URIs on ${platform()}.`,
      `Open this by hand: ${uri}`,
    );
  }

  try {
    await run(opener.command, [...opener.args, uri], { timeoutMs: 15_000 });
    log.info(`opened ${uri}`);
  } catch (err) {
    const detail = err instanceof CommandError ? err.stderr.trim() || err.message : String(err);
    throw new UserFacingError(
      `Could not hand ${uri} to Warp: ${detail}`,
      "Is Warp installed and registered for the warp:// URI scheme?",
    );
  }
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
    default:
      return "cyan";
  }
}
