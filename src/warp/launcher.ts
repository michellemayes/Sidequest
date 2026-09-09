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
}

export interface LaunchResult {
  /** The strategy that actually opened Warp, after any fallback. */
  strategy: WarpStrategy;
  uri: string;
  /** True when we fell back because the preferred strategy failed. */
  fellBack: boolean;
}

/**
 * Open Warp on a prepared worktree.
 *
 * `launch_config` and `tab_config` give a titled, coloured tab and ask Warp to
 * run the command itself. `new_tab` only sets the directory — the shell hook
 * starts Claude there. If the preferred strategy fails to open we fall back to
 * `new_tab`, which is the one that has always worked.
 */
export async function launchWarp(options: LaunchOptions): Promise<LaunchResult> {
  const { spec, preview } = options;

  try {
    const uri = await buildUri(options);
    await openUri(uri);
    return { strategy: options.strategy, uri, fellBack: false };
  } catch (err) {
    if (options.strategy === "new_tab") throw err;
    log.warn(
      `${options.strategy} launch failed, falling back to new_tab`,
      err instanceof Error ? err.message : err,
    );
    const uri = newTabUri(spec.cwd, preview);
    await openUri(uri);
    return { strategy: "new_tab", uri, fellBack: true };
  }
}

async function buildUri(options: LaunchOptions): Promise<string> {
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
      `ccslack does not know how to open URIs on ${platform()}.`,
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
