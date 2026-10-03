import { configFile, shellHookFile } from "../config/paths.js";
import { ensureConfigRoot, loadConfig, saveConfig } from "../config/store.js";
import { start } from "./daemon.js";
import { doctor } from "./doctor.js";
import { installHook } from "./hook.js";
import { exists } from "../util/fs.js";

/**
 * First run, start to finish: a config to edit, the shell hook, a doctor
 * pass, and — if nothing is broken — Slack with the overlay on it. Each step
 * is the command of the same name, so running it twice changes nothing.
 */
export async function setup(options: { force: boolean }): Promise<void> {
  console.log("1/4  config");
  await init({ quiet: true });
  console.log("2/4  shell hook");
  if (await exists(shellHookFile())) console.log(`     already installed at ${shellHookFile()}`);
  else await installHook({ print: false });
  console.log("3/4  checks");
  await doctor();
  if (process.exitCode) {
    console.log("Fix what doctor flagged above, then run `sidequest setup` again.");
    return;
  }
  console.log("4/4  start");
  await start({ force: options.force, foreground: false });
}

export async function init(options: { quiet?: boolean } = {}): Promise<void> {
  const root = await ensureConfigRoot();
  // Round-trips defaults into the file so it is there to edit.
  await saveConfig(await loadConfig());

  console.log(`${options.quiet ? "     " : ""}Wrote ${configFile()}`);
  if (options.quiet) return;
  console.log(`Config lives in ${root}.`);
  console.log("\nNext:");
  console.log("  1. sidequest install-hook   (so sessions start when the Warp tab opens)");
  console.log("     sidequest terminal       (if you'd rather use iTerm2, Ghostty, Terminal, tmux or none)");
  console.log("  2. sidequest start          (launches Slack with the overlay attached)");
  console.log("  3. In Slack, click 'Link a repo' in a channel header.");
}
