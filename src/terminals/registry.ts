import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TERMINAL_IDS, type TerminalId } from "../config/schema.js";

export { TERMINAL_IDS, type TerminalId };

export interface TerminalDefinition {
  id: TerminalId;
  /** Human label, shown in the overlay and CLI output. */
  label: string;
  /** Where the agent runs, as the end of a sentence: "starting in Warp". */
  place: string;
  /** One line for `sidequest terminal`. */
  summary: string;
  /** The app bundle(s) to look for on macOS, if it is an app. */
  apps: string[];
  /** Shown by `sidequest doctor` when the terminal is not usable. */
  installHint: string;
}

export const TERMINAL_DEFINITIONS: TerminalDefinition[] = [
  {
    id: "warp",
    label: "Warp",
    place: "in Warp",
    summary: "a coloured Warp tab, via tab configs, launch configs or the shell hook",
    apps: ["Warp.app", "WarpPreview.app"],
    installHint: "Install Warp (https://www.warp.dev/).",
  },
  {
    id: "iterm2",
    label: "iTerm2",
    place: "in iTerm2",
    summary: "a new iTerm2 tab (or window, if none is open), driven by AppleScript",
    apps: ["iTerm.app"],
    installHint: "Install iTerm2 (https://iterm2.com/).",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    place: "in Ghostty",
    summary: "a new Ghostty window on the worktree",
    apps: ["Ghostty.app"],
    installHint: "Install Ghostty (https://ghostty.org/).",
  },
  {
    id: "terminal",
    label: "Terminal",
    place: "in Terminal",
    summary: "a new Terminal.app window, driven by AppleScript",
    apps: ["Terminal.app"],
    installHint: "Terminal.app ships with macOS; check it has not been removed.",
  },
  {
    id: "tmux",
    label: "tmux",
    place: "in tmux",
    summary: "a new window in your running tmux server (or a detached `sidequest` session)",
    apps: [],
    installHint: "Install tmux (brew install tmux).",
  },
  {
    id: "headless",
    label: "Headless",
    place: "in the background",
    summary: "no terminal: the agent runs on its own, logs to .sidequest/agent.log, answers in .sidequest/result.md",
    apps: [],
    installHint: "",
  },
];

export function terminalDefinition(id: TerminalId): TerminalDefinition {
  return TERMINAL_DEFINITIONS.find((d) => d.id === id) ?? TERMINAL_DEFINITIONS[0]!;
}

/**
 * Where sessions open, as the overlay and CLI name it: an agent that lives in
 * a desktop app opens there whatever the terminal setting; otherwise it's the
 * terminal, or "the background" when headless.
 */
export function sessionHost(agent: { host: string; app?: unknown }, terminal: TerminalId): string {
  if (agent.app) return agent.host;
  return terminal === "headless" ? "the background" : terminalDefinition(terminal).label;
}

/** Where macOS apps live; Terminal.app is a system app. */
const APP_DIRS = ["/Applications", join(homedir(), "Applications"), "/System/Applications/Utilities"];

/** The installed bundle for a terminal, or null (always null for non-apps). */
export function findTerminalApp(id: TerminalId): string | null {
  for (const app of terminalDefinition(id).apps) {
    for (const dir of APP_DIRS) {
      const path = join(dir, app);
      if (existsSync(path)) return path;
    }
  }
  return null;
}
