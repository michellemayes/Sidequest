import { run, succeeds, CommandError } from "../util/exec.js";
import { platform, uriOpener } from "../util/platform.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import type { Settings } from "../config/schema.js";
import type { WarpColor } from "../warp/configFiles.js";
import {
  CLAIM_TIMEOUT_MS,
  exists,
  launchWarp,
  waitForClaim,
  type PreparedTabConfig,
} from "../warp/launcher.js";
import {
  ghosttyArgv,
  iterm2Argv,
  terminalAppArgv,
  tmuxHasSessionArgv,
  tmuxNewSessionArgv,
  tmuxNewWindowArgv,
  TMUX_FALLBACK_SESSION,
  type Argv,
  type OpenSpec,
} from "./commands.js";
import { headlessPaths, spawnHeadless } from "./headless.js";
import { terminalDefinition, type TerminalId } from "./registry.js";

/** One session to open, whichever terminal it opens in. */
export interface TerminalSession {
  /** Unique, filename-safe name; Warp's config files are named for it. */
  name: string;
  /** Warp's tab colour; the other terminals have no equivalent. */
  color: WarpColor;
  /** Starting title, where a terminal pins one (a tmux window name). */
  title: string;
  /** The worktree. */
  cwd: string;
  /**
   * What starts the agent: autorun.sh, or headless.sh for `headless`. Null
   * when there is none, and the terminal just opens on the worktree.
   */
  script: string | null;
  /** The session's pending marker; see launchWarp. */
  pendingFile?: string;
}

export interface TerminalLaunchOptions {
  settings: Settings;
  session: TerminalSession;
  /** Warp only: a tab config written while the worktree was checked out. */
  preparedTabConfig?: PreparedTabConfig;
  /** How long to wait for the agent to claim the pending marker. */
  claimTimeoutMs?: number;
}

export interface TerminalLaunchResult {
  terminal: TerminalId;
  /** How it opened: Warp's strategy after any fallback, else a short tag. */
  strategy: string;
  /** Warp only: the preferred strategy failed and another one was used. */
  fellBack: boolean;
  /**
   * Whether the agent claimed the session's pending marker in time; null when
   * there was nothing to watch.
   */
  agentStarted: boolean | null;
  /** Anything worth telling the user, e.g. how to attach to a new tmux session. */
  note?: string;
}

/**
 * Open a session in the configured terminal.
 *
 * Every terminal starts the agent the same way, by running the session's
 * script, which reads the prompt from its file and claims the pending marker.
 * So as with Warp, a launch only counts once the marker is gone: opening a
 * terminal and running something in it are two different things.
 */
export async function launchTerminal(options: TerminalLaunchOptions): Promise<TerminalLaunchResult> {
  const { settings, session } = options;
  const terminal = settings.terminal;

  if (terminal === "warp") {
    const launch = await launchWarp({
      // With nothing to run, a plain tab is all there is to open.
      strategy: session.script ? settings.warpStrategy : "new_tab",
      preview: settings.warpPreview,
      spec: { name: session.name, color: session.color, cwd: session.cwd, command: session.script ?? "true" },
      pendingFile: session.pendingFile,
      preparedTabConfig: options.preparedTabConfig,
      claimTimeoutMs: options.claimTimeoutMs,
    });
    return { terminal, strategy: launch.strategy, fellBack: launch.fellBack, agentStarted: launch.agentStarted };
  }

  const watch =
    session.script && session.pendingFile && (await exists(session.pendingFile)) ? session.pendingFile : null;
  const claimed = async (): Promise<boolean | null> =>
    watch ? waitForClaim(watch, options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS) : null;
  const spec: OpenSpec = { cwd: session.cwd, script: session.script, title: session.title };

  switch (terminal) {
    case "iterm2":
    case "terminal": {
      requireMac(terminal);
      await openWith(terminal, terminal === "iterm2" ? iterm2Argv(spec) : terminalAppArgv(spec));
      return { terminal, strategy: terminal, fellBack: false, agentStarted: await claimed() };
    }
    case "ghostty": {
      await openWith(terminal, ghosttyArgv(spec, platform() === "darwin"));
      return { terminal, strategy: terminal, fellBack: false, agentStarted: await claimed() };
    }
    case "tmux": {
      const target = settings.tmuxSession.trim();
      const hasSession = tmuxHasSessionArgv(target);
      const tmuxSpec = { ...spec, session: target };
      if (await succeeds(hasSession.command, hasSession.args)) {
        await openWith(terminal, tmuxNewWindowArgv(tmuxSpec));
        return { terminal, strategy: "tmux window", fellBack: false, agentStarted: await claimed() };
      }
      const name = target || TMUX_FALLBACK_SESSION;
      await openWith(terminal, tmuxNewSessionArgv(tmuxSpec));
      return {
        terminal,
        strategy: "tmux session",
        fellBack: false,
        agentStarted: await claimed(),
        note: `Started tmux session "${name}". Attach with \`tmux attach -t ${name}\`.`,
      };
    }
    case "headless":
      return launchHeadless(session, claimed);
  }
}

/**
 * Headless has no window to reopen. A session still waiting to run is
 * started; one that has run opens its answer, or its log while it works.
 */
async function launchHeadless(
  session: TerminalSession,
  claimed: () => Promise<boolean | null>,
): Promise<TerminalLaunchResult> {
  if (session.script && session.pendingFile && (await exists(session.pendingFile))) {
    await spawnHeadless(session.script, session.cwd).catch((err: unknown) => {
      throw new UserFacingError(
        `Could not start the agent in the background: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    log.info(`started ${session.script} in the background`);
    return { terminal: "headless", strategy: "headless", fellBack: false, agentStarted: await claimed() };
  }

  const files = headlessPaths(session.cwd);
  const target = (await exists(files.resultFile))
    ? files.resultFile
    : (await exists(files.logFile))
      ? files.logFile
      : session.cwd;
  const opener = uriOpener();
  if (!opener) {
    throw new UserFacingError(`sidequest does not know how to open files on ${platform()}.`, `Look in ${target}.`);
  }
  await openWith("headless", { command: opener.command, args: [...opener.args, target] });
  return { terminal: "headless", strategy: "opened", fellBack: false, agentStarted: null, note: `Opened ${target}.` };
}

function requireMac(terminal: TerminalId): void {
  if (platform() !== "darwin") {
    throw new UserFacingError(
      `${terminalDefinition(terminal).label} is only on macOS.`,
      "Pick another terminal with `sidequest terminal`.",
    );
  }
}

async function openWith(terminal: TerminalId, argv: Argv): Promise<void> {
  const label = terminalDefinition(terminal).label;
  try {
    await run(argv.command, argv.args, { timeoutMs: 30_000 });
    log.info(`opened ${label} with ${argv.command}`);
  } catch (err) {
    const detail = err instanceof CommandError ? err.stderr.trim() || err.message : String(err);
    throw new UserFacingError(`Could not open ${label}: ${detail}`, openHint(terminal));
  }
}

function openHint(terminal: TerminalId): string {
  switch (terminal) {
    case "iterm2":
    case "terminal":
      return (
        `Is ${terminalDefinition(terminal).label} installed? The first time, macOS asks whether ` +
        "Sidequest may control it: allow it in System Settings → Privacy & Security → Automation."
      );
    case "tmux":
      return "Is tmux installed and on the daemon's PATH?";
    default:
      return terminalDefinition(terminal).installHint;
  }
}

/**
 * What to tell the user when the terminal opened but nothing claimed the
 * session, per terminal, since the fix differs.
 */
export function agentDidNotStart(terminal: TerminalId): string {
  switch (terminal) {
    case "warp":
      // Warp ignored the launch config and the shell hook that would catch
      // that is not installed.
      return "Warp opened but the agent did not start. Run `sidequest install-hook`, then `sidequest reopen`.";
    case "headless":
      return "The agent did not start in the background. See .sidequest/agent.log in the worktree.";
    default:
      return (
        `${terminalDefinition(terminal).label} opened but the agent did not start. ` +
        "Run .sidequest/autorun.sh in the worktree, or `sidequest reopen`."
      );
  }
}
