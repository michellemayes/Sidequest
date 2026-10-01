/**
 * The exact commands that open each terminal, as argv arrays. Nothing here
 * runs anything, so every one can be checked in a test without the terminal.
 *
 * None of them carries message text. The prompt stays in
 * `.sidequest/prompt.md`, and what a terminal is told to run is the session's
 * autorun script, whose path Sidequest chose. Where a terminal only takes a
 * command line (AppleScript's `write text` and `do script`), the path is
 * quoted by AppleScript's own `quoted form of`, from an argv item, never by
 * splicing it into the script source.
 */

export interface Argv {
  command: string;
  args: string[];
}

export interface OpenSpec {
  /** The worktree to open on. */
  cwd: string;
  /** Script to run there, or null for just a shell in the directory. */
  script: string | null;
  /** Window or tab name, where the terminal has one that sticks. */
  title: string;
}

/**
 * Runs the script, then leaves a login shell in its place, so the tab stays
 * open on the worktree once the agent exits, as a typed command would. The
 * shell code is fixed; the script path arrives as `$1`.
 */
export function keepShellArgv(script: string): string[] {
  return ["/bin/bash", "-c", `"$1"; exec "\${SHELL:-/bin/zsh}" -l`, "sidequest", script];
}

/**
 * AppleScript that turns `argv` (cwd, then optionally a script) into the
 * command line a terminal types: `cd '<cwd>' && '<script>'`.
 */
const COMMAND_LINE = [
  "set cmd to \"cd \" & quoted form of (item 1 of argv)",
  "if (count of argv) > 1 then set cmd to cmd & \" && \" & quoted form of (item 2 of argv)",
];

/**
 * Wait for an app launched by `activate` to open its first window, so we use
 * that one rather than opening a second beside it.
 */
const WAIT_FOR_WINDOW = [
  "if not wasRunning then",
  "repeat 50 times",
  "if (count of windows) > 0 then exit repeat",
  "delay 0.1",
  "end repeat",
  "end if",
];

function osascript(lines: string[], spec: OpenSpec): Argv {
  const args = lines.flatMap((line) => ["-e", line]);
  // Everything after the script is `argv` in the run handler.
  args.push(spec.cwd);
  if (spec.script) args.push(spec.script);
  return { command: "osascript", args };
}

/**
 * iTerm2: a new tab in the front window, or the window a fresh launch opens,
 * or a new window when there is none, then type the command into it.
 */
export function iterm2Argv(spec: OpenSpec): Argv {
  return osascript(
    [
      "on run argv",
      ...COMMAND_LINE,
      'set wasRunning to application id "com.googlecode.iterm2" is running',
      'tell application id "com.googlecode.iterm2"',
      "activate",
      ...WAIT_FOR_WINDOW,
      "if (count of windows) is 0 then",
      "create window with default profile",
      "else if wasRunning then",
      "tell current window to create tab with default profile",
      "end if",
      "tell current session of current window to write text cmd",
      "end tell",
      "end run",
    ],
    spec,
  );
}

/**
 * Terminal.app: `do script` opens a new window running the command; when
 * Terminal was just launched, use the window it opened instead.
 */
export function terminalAppArgv(spec: OpenSpec): Argv {
  return osascript(
    [
      "on run argv",
      ...COMMAND_LINE,
      'set wasRunning to application id "com.apple.Terminal" is running',
      'tell application id "com.apple.Terminal"',
      "activate",
      ...WAIT_FOR_WINDOW,
      "if wasRunning or (count of windows) is 0 then",
      "do script cmd",
      "else",
      "do script cmd in window 1",
      "end if",
      "end tell",
      "end run",
    ],
    spec,
  );
}

/**
 * Ghostty takes its working directory and command as flags. On macOS its
 * binary can't be launched directly, so `open -na` starts a new instance with
 * them, which is how Ghostty documents opening a window from the command line.
 * `-e` must come last: everything after it is the command, which Ghostty
 * 1.2 and later run as given rather than through a shell.
 */
export function ghosttyArgv(spec: OpenSpec, onMac: boolean): Argv {
  const flags = [`--working-directory=${spec.cwd}`];
  if (spec.script) flags.push("-e", ...keepShellArgv(spec.script));
  return onMac
    ? { command: "open", args: ["-na", "Ghostty.app", "--args", ...flags] }
    : { command: "ghostty", args: flags };
}

export interface TmuxSpec extends OpenSpec {
  /** Session to add the window to; empty means the one tmux used last. */
  session: string;
}

/** The session Sidequest starts when no tmux server is running. */
export const TMUX_FALLBACK_SESSION = "sidequest";

/**
 * A new window in a running tmux server. tmux runs a command given as
 * several arguments directly, with no shell in between.
 */
export function tmuxNewWindowArgv(spec: TmuxSpec): Argv {
  const args = ["new-window"];
  // `=` matches the name exactly; the trailing colon makes it a session, so
  // the window goes at the session's next free index.
  if (spec.session) args.push("-t", `=${spec.session}:`);
  args.push("-c", spec.cwd, "-n", spec.title);
  if (spec.script) args.push("--", ...keepShellArgv(spec.script));
  return { command: "tmux", args };
}

/**
 * With no server to add a window to, start a detached session instead; the
 * user attaches with `tmux attach -t <session>`.
 */
export function tmuxNewSessionArgv(spec: TmuxSpec): Argv {
  const args = ["new-session", "-d", "-s", spec.session || TMUX_FALLBACK_SESSION];
  args.push("-c", spec.cwd, "-n", spec.title);
  if (spec.script) args.push("--", ...keepShellArgv(spec.script));
  return { command: "tmux", args };
}

/** Exits zero when the tmux server has the session (or, with none named, any). */
export function tmuxHasSessionArgv(session: string): Argv {
  return { command: "tmux", args: session ? ["has-session", "-t", `=${session}`] : ["has-session"] };
}
