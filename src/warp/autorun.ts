import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { PROMPT_FILE_TOKEN, PROMPT_TOKEN } from "../agents/agents.js";
import { UserFacingError } from "../util/errors.js";

/** Directory inside each worktree holding the generated session files. */
export const SESSION_DIR = ".sidequest";

/**
 * What the `pending` marker holds when a session that has already run is
 * opened again: the script then picks up the agent's last conversation
 * instead of sending the prompt a second time.
 */
export const CONTINUE_MARKER = "continue";

/** Marks a script that knows the continue marker; older ones don't. */
const CONTINUE_SENTINEL = "# sidequest:continue";

/**
 * What the `pending` marker holds for a follow-up: the script then runs the
 * agent on followup.md (carrying on its conversation, where it can) instead
 * of on prompt.md.
 */
export const FOLLOWUP_MARKER = "followup";
export const FOLLOWUP_FILE = "followup.md";
/** Marks a script that knows the follow-up marker, autorun.sh or headless.sh alike. */
export const FOLLOWUP_SENTINEL = "# sidequest:followup";

export interface AutorunFiles {
  dir: string;
  promptFile: string;
  scriptFile: string;
  pendingFile: string;
}

export function autorunPaths(worktreePath: string): AutorunFiles {
  const dir = join(worktreePath, SESSION_DIR);
  return {
    dir,
    promptFile: join(dir, "prompt.md"),
    scriptFile: join(dir, "autorun.sh"),
    pendingFile: join(dir, "pending"),
  };
}

/** POSIX single-quote escaping: close, escape, reopen. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface WriteAutorunOptions {
  worktreePath: string;
  prompt: string;
  agentCommand: string;
  agentArgs: string[];
  /**
   * How the prompt is passed, after the args; `{prompt}` and `{promptFile}`
   * are filled in. Defaults to the prompt as one trailing argument.
   */
  promptArgs?: string[];
  /** Args for a second run once the first exits, for one-shot-only CLIs. */
  resumeArgs?: string[];
  /**
   * Args, straight after the command, that reopen the worktree's latest
   * conversation; run instead of the prompt when the session is reopened.
   */
  continueArgs?: string[];
  /**
   * Args after the command for a follow-up from Slack, with the prompt
   * placeholders reading followup.md: the agent's continue args first where
   * it takes a prompt with them. Absent, the script cannot take follow-ups.
   */
  followUpArgs?: string[];
  /** Human label for comments only, e.g. "Codex". */
  agentLabel?: string;
  /** Starting terminal title; the agent may replace it. */
  title?: string;
  /**
   * Leave the `pending` marker for Warp or the shell hook to claim. Off for an
   * agent in a desktop app: the app runs the session, and a marker left behind
   * would start a second agent in the first terminal opened there.
   */
  pending?: boolean;
}

/**
 * Write the prompt and a run-once launcher script into the worktree.
 *
 * Warp has historically ignored `exec` entries when a launch configuration is
 * opened via the warp:// deeplink (warpdotdev/warp#9007), and the shell hook is
 * opt-in, so both paths may fire — or only one of them. The script claims the
 * `pending` marker with an atomic rename, so whichever path runs first starts
 * the agent and the other exits quietly.
 */
export async function writeAutorun(options: WriteAutorunOptions): Promise<AutorunFiles> {
  const paths = autorunPaths(options.worktreePath);
  await mkdir(paths.dir, { recursive: true });

  // Separate files, and nothing runs the script until this returns, so they
  // are written side by side.
  await Promise.all([
    writeFile(paths.promptFile, `${options.prompt}\n`, "utf8"),
    options.pending !== false ? writeFile(paths.pendingFile, "", "utf8") : null,
    writeFile(paths.scriptFile, renderScript(options), "utf8").then(() => chmod(paths.scriptFile, 0o755)),
  ]);

  return paths;
}

/**
 * One argv entry for the script. Literal text is single-quoted; the prompt
 * placeholders become double-quoted expansions, so the prompt is read from
 * disk at run time and its shell metacharacters stay literal. They read
 * `$prompt_file`: prompt.md, or followup.md for a follow-up.
 */
export function shellArg(arg: string): string {
  return arg
    .split(/(\{prompt\}|\{promptFile\})/)
    .filter((part) => part !== "")
    .map((part) => {
      if (part === PROMPT_TOKEN) return `"$(cat "$prompt_file")"`;
      if (part === PROMPT_FILE_TOKEN) return `"$prompt_file"`;
      return shellQuote(part);
    })
    .join("") || "''";
}

function renderScript(options: WriteAutorunOptions): string {
  const title = shellQuote((options.title ?? "sidequest").replace(/[\u0000-\u001f\u007f]/g, ""));
  const base = [options.agentCommand, ...options.agentArgs].map(shellQuote);
  const command = [...base, ...(options.promptArgs ?? [PROMPT_TOKEN]).map(shellArg)].join(" ");
  // A reopened session carries on its conversation rather than starting over.
  const continueBlock = options.continueArgs
    ? `${CONTINUE_SENTINEL}
if [ "$(cat "$started")" = ${shellQuote(CONTINUE_MARKER)} ]; then
  printf '\\033]0;%s\\007' ${title}
  ${[options.agentCommand, ...options.continueArgs, ...options.agentArgs].map(shellQuote).join(" ")}
  exit
fi

`
    : "";
  // A one-shot CLI gets a second, interactive run on the same conversation.
  const resume = options.resumeArgs ? `\n${[...base, ...options.resumeArgs.map(shellQuote)].join(" ")}` : "";
  // A follow-up from Slack: the agent again, on followup.md.
  const followUpBlock = options.followUpArgs
    ? `${FOLLOWUP_SENTINEL}
if [ "$(cat "$started")" = ${shellQuote(FOLLOWUP_MARKER)} ]; then
  prompt_file="$session_dir/${FOLLOWUP_FILE}"
  printf '\\033]0;%s\\007' ${title}
  ${[shellQuote(options.agentCommand), ...options.followUpArgs.map(shellArg)].join(" ")}${resume.replace(/\n/, "\n  ")}
  exit
fi

`
    : "";
  const agentLine = options.agentLabel ? `# Agent: ${options.agentLabel}\n` : "";

  return `#!/usr/bin/env bash
# Generated by sidequest. Regenerated for every session; safe to delete.
${agentLine}set -uo pipefail

session_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
worktree="$(dirname "$session_dir")"
pending="$session_dir/pending"
started="$session_dir/started"

# Claim the run. mv is atomic, so exactly one caller gets past this line even if
# Warp's launch config and the shell hook both fire.
if ! mv "$pending" "$started" 2>/dev/null; then
  exit 0
fi

cd "$worktree" || exit 1
prompt_file="$session_dir/prompt.md"

${followUpBlock}${continueBlock}if [ ! -f "$prompt_file" ]; then
  echo "Sidequest: prompt.md is missing from $session_dir" >&2
  exit 1
fi

printf '\\033]0;%s\\007' ${title}
${command}${resume}
`;
}

/**
 * Ask the session's script to carry on the agent's last conversation the next
 * time it runs, by putting the pending marker back with the continue marker in
 * it. Only for a session that has already started and whose script knows how;
 * returns whether it did.
 */
export async function armContinue(worktreePath: string): Promise<boolean> {
  const paths = autorunPaths(worktreePath);
  let script: string;
  try {
    script = await readFile(paths.scriptFile, "utf8");
  } catch {
    return false;
  }
  if (!script.includes(CONTINUE_SENTINEL)) return false;
  try {
    // wx: a session still waiting for its first run keeps its own marker.
    await writeFile(paths.pendingFile, CONTINUE_MARKER, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the session's script to run the agent on a follow-up the next time it
 * runs: followup.md written, and the pending marker put back with the
 * follow-up marker in it. `scriptFile` is the script that will claim it
 * (autorun.sh, or headless.sh). A session that has not started yet has
 * nothing to follow up, and one whose script predates follow-ups cannot.
 */
export async function armFollowUp(worktreePath: string, scriptFile: string, text: string): Promise<void> {
  const paths = autorunPaths(worktreePath);
  let script = "";
  try {
    script = await readFile(scriptFile, "utf8");
  } catch {
    // Treated as too old below.
  }
  if (!script.includes(FOLLOWUP_SENTINEL)) {
    throw new UserFacingError(
      "That session was started before Sidequest took follow-ups.",
      "Go back to it and tell the agent there, or start a new session.",
    );
  }
  let waiting: string | null = null;
  try {
    waiting = await readFile(paths.pendingFile, "utf8");
  } catch {
    // No marker: the session has run, which is what a follow-up wants.
  }
  // A reopen that has not been picked up yet gives way to the follow-up.
  if (waiting !== null && waiting !== CONTINUE_MARKER && waiting !== FOLLOWUP_MARKER) {
    throw new UserFacingError(
      "That session has not started yet.",
      "Open it first; the follow-up can wait until the agent is on it.",
    );
  }
  await writeFile(join(paths.dir, FOLLOWUP_FILE), `${text}\n`, "utf8");
  await writeFile(paths.pendingFile, FOLLOWUP_MARKER, "utf8");
}

/**
 * The snippet users add to their shell rc. It runs the autorun script when a
 * shell starts inside a worktree that still has an unclaimed session.
 *
 * It waits for the first prompt rather than running while the rc file is
 * sourced: Warp finishes setting a session up after the rc files, and an
 * agent started before then takes over the terminal mid-bootstrap.
 */
export function shellHookSource(): string {
  return `# sidequest shell hook
# Starts the agent session when a shell opens in a sidequest worktree.
# Added by: sidequest install-hook
_sidequest_autorun() {
  [ -n "\${SIDEQUEST_AUTORUN_RAN:-}" ] && return 0
  SIDEQUEST_AUTORUN_RAN=1
  [ -f "$PWD/${SESSION_DIR}/pending" ] || return 0
  [ -x "$PWD/${SESSION_DIR}/autorun.sh" ] || return 0
  "$PWD/${SESSION_DIR}/autorun.sh"
}
if [ -n "\${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook
  _sidequest_first_prompt() {
    add-zsh-hook -d precmd _sidequest_first_prompt
    _sidequest_autorun
  }
  add-zsh-hook precmd _sidequest_first_prompt
elif [ -n "\${BASH_VERSION:-}" ]; then
  PROMPT_COMMAND="_sidequest_autorun\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
else
  _sidequest_autorun
fi
`;
}
