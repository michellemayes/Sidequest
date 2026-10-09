import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installRoot } from "../update.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import { link, unlink } from "./channels.js";
import { start, status, stop } from "./daemon.js";
import { doctor } from "./doctor.js";
import { installHook } from "./hook.js";
import { mcpApprove } from "./mcpApprove.js";
import { clean, pr, reopen, sessions, stats } from "./sessions.js";
import { agents, list, prompts, replies, skipPermissions, sync, terminal } from "./settings.js";
import { init, setup } from "./setup.js";
import { update } from "./update.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("sidequest")
    .description("Turn any Slack message into an agent session in a fresh git worktree, opened in your terminal or a desktop app.")
    .version(packageVersion());

  program
    .command("setup")
    .description("everything in one go: config, shell hook, checks, then start")
    .option("--force", "quit a running Slack that has no DevTools port", false)
    .action((options: { force: boolean }) => wrap(() => setup(options)));

  program
    .command("start")
    .description("launch Slack with the overlay attached (runs in the background by default)")
    .option("--force", "quit a running Slack that has no DevTools port", false)
    .option("--foreground", "stay in the foreground instead of daemonizing", false)
    .action((options: { force: boolean; foreground: boolean }) => wrap(() => start(options)));

  program
    .command("stop")
    .description("stop the background Sidequest daemon")
    .action(() => wrap(stop));

  program
    .command("status")
    .description("show whether the background daemon is running")
    .action(() => wrap(status));

  program
    .command("agents [id]")
    .description("list the coding agents Sidequest can launch, or switch to one (claude, codex, gemini, aider, claude-desktop, ...)")
    .action((id: string | undefined) => wrap(() => agents(id)));

  program
    .command("terminal [name]")
    .description("show the terminals sessions can open in, or switch to one (warp, iterm2, ghostty, terminal, tmux, headless)")
    .action((name: string | undefined) => wrap(() => terminal(name)));

  program
    .command("replies [state]")
    .description("show the thread replies sessions post, or turn them on or off")
    .action((state: string | undefined) => wrap(() => replies(state)));

  program
    .command("skip-permissions [state]")
    .description("start agents with permission prompts off (--dangerously-skip-permissions and the like), on or off")
    .action((state: string | undefined) => wrap(() => skipPermissions(state)));

  program
    .command("sync [state]")
    .description("share channel links, prompts and settings with your other computers through Slack (on or off)")
    .action((state: string | undefined) => wrap(() => sync(state)));

  program
    .command("reopen [ref]")
    .description("open a session's terminal (or the agent's app) again (branch name or path; default: the latest)")
    .action((ref: string | undefined) => wrap(() => reopen(ref)));

  program
    .command("pr [ref]")
    .description("push a session's branch and open a draft pull request for it (branch name or path; default: the latest)")
    .action((ref: string | undefined) => wrap(() => pr(ref)));

  program
    .command("stats")
    .description("how many sidequests, how many today, and your streak")
    .action(() => wrap(stats));

  program
    .command("link <path>")
    .description("link a Slack channel to a repo from the terminal (a channel can have several)")
    .requiredOption("-c, --channel <name>", "channel name, e.g. eng-alerts")
    .option("-b, --base <branch>", "branch to cut worktrees from (default: detected)")
    .option("-l, --label <name>", "display name for the repo")
    .action((path: string, options: { channel: string; base?: string; label?: string }) =>
      wrap(() => link(path, options)),
    );

  program
    .command("unlink [repo]")
    .description("remove one repo (by path or label) from a channel, or all of them")
    .requiredOption("-c, --channel <name>", "channel name, e.g. eng-alerts")
    .action((repo: string | undefined, options: { channel: string }) =>
      wrap(() => unlink(options.channel, repo)),
    );

  program
    .command("list")
    .description("show linked channels and settings")
    .action(() => wrap(list));

  program
    .command("sessions")
    .description("list worktrees Sidequest has created")
    .action(() => wrap(sessions));

  program
    .command("clean")
    .description("remove finished worktrees")
    .option("--force", "also remove worktrees with uncommitted changes", false)
    .option("--all", "remove every Sidequest worktree, not just merged ones", false)
    .option("--recent", "also remove worktrees touched in the last hour", false)
    .action((options: { force: boolean; all: boolean; recent: boolean }) => wrap(() => clean(options)));

  program
    .command("init")
    .description("write a starter config to ~/.sidequest")
    .action(() => wrap(() => init()));

  program
    .command("install-hook")
    .description("add the shell hook that starts the agent when a worktree tab opens")
    .option("--rc <path>", "shell rc file to modify (default: detected)")
    .option("--print", "print the snippet instead of writing it", false)
    .action((options: { rc?: string; print: boolean }) => wrap(() => installHook(options)));

  program
    .command("prompts")
    .description("show the three prompt templates and where to override them")
    .action(() => wrap(prompts));

  program
    .command("update")
    .description("pull the latest Sidequest, rebuild, and restart the daemon if it's running")
    .option("--no-restart", "leave a running daemon on the old version")
    .action((options: { restart: boolean }) => wrap(() => update(options)));

  // Started by a headless Claude Code, not by people: see src/cli/mcpApprove.ts.
  program
    .command("mcp-approve", { hidden: true })
    .requiredOption("--worktree <path>", "the session's worktree")
    .action((options: { worktree: string }) => wrap(() => mcpApprove(options)));

  program
    .command("doctor")
    .description("check that git, your terminal, the agent and Slack are all usable")
    .action(() => wrap(doctor));

  await program.parseAsync(argv);
}

/** Turn thrown errors into a clean message plus a non-zero exit. */
async function wrap(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const { message, hint } = describeError(err);
    console.error(`\nerror: ${message}`);
    if (hint) console.error(`hint:  ${hint}`);
    if (!(err instanceof UserFacingError)) log.debug("stack", err);
    process.exitCode = 1;
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(installRoot(), "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}
