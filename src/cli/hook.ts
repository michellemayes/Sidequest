import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { configRoot, shellHookFile } from "../config/paths.js";
import { expandPath } from "../config/store.js";
import { UserFacingError } from "../util/errors.js";
import { shellHookSource } from "../warp/autorun.js";
import { fileExists, readFileOrEmpty } from "./shared.js";

export async function installHook(options: { rc?: string; print: boolean }): Promise<void> {
  const snippet = shellHookSource();
  const hookPath = shellHookFile();

  if (options.print) {
    console.log(snippet);
    return;
  }

  await mkdir(configRoot(), { recursive: true });
  await writeFile(hookPath, snippet, "utf8");

  const rc = options.rc ? expandPath(options.rc) : detectRcFile();
  const sourceLine = `[ -f "${hookPath}" ] && . "${hookPath}"`;
  const existing = await readFileOrEmpty(rc);

  if (existing.includes(hookPath)) {
    console.log(`${rc} already sources the hook — nothing to do.`);
    return;
  }

  await appendFile(rc, `\n# sidequest\n${sourceLine}\n`, "utf8");
  console.log(`Wrote ${hookPath}`);
  console.log(`Added a source line to ${rc}`);
  console.log("\nOpen a new terminal for it to take effect.");
}

/**
 * An installed hook is a copy of shellHookSource() from whichever version
 * wrote it; bring it up to date so fixes reach people who installed earlier.
 */
export async function refreshShellHook(): Promise<void> {
  const hookPath = shellHookFile();
  if (!(await fileExists(hookPath))) return;
  const snippet = shellHookSource();
  if ((await readFileOrEmpty(hookPath)) === snippet) return;
  await writeFile(hookPath, snippet, "utf8");
  console.log(`Updated the shell hook at ${hookPath}. Open a new Warp tab for it to take effect.`);
}

/** Pick the rc file for the user's login shell. */
function detectRcFile(): string {
  const shell = basename(process.env.SHELL ?? "zsh");
  switch (shell) {
    case "bash":
      return join(homedir(), ".bashrc");
    case "fish":
      // The fish snippet is POSIX-ish enough to fail loudly rather than silently.
      throw new UserFacingError(
        "fish is not supported by the generated hook.",
        `Run \`sidequest install-hook --print\` and translate it, or set warpStrategy to "tab_config".`,
      );
    default:
      return join(homedir(), ".zshrc");
  }
}
