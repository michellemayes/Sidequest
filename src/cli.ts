import { Command } from "commander";
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { configFile, configRoot, envFile, shellHookFile } from "./config/paths.js";
import {
  allPrompts,
  ensureConfigRoot,
  expandPath,
  loadConfig,
  saveConfig,
  updateConfig,
} from "./config/store.js";
import { assertGitAvailable, inspectRepo, isMergedInto } from "./git/repo.js";
import { listWorktrees, pruneWorktrees, removeWorktree } from "./git/worktree.js";
import { shellHookSource } from "./warp/autorun.js";
import { warpLaunchConfigDir, warpTabConfigDir, platform, uriOpener } from "./util/platform.js";
import { createSlackApp, readCredentials, verifyCredentials } from "./slack/app.js";
import { describeError, UserFacingError } from "./util/errors.js";
import { succeeds } from "./util/exec.js";
import { log } from "./util/log.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("ccslack")
    .description("Turn any Slack message into a Claude Code session in a fresh git worktree, opened in Warp.")
    .version("0.1.0");

  program
    .command("start")
    .description("connect to Slack and listen for message shortcuts")
    .action(() => wrap(start));

  program
    .command("link <path>")
    .description("link a Slack channel to a repo from the terminal")
    .requiredOption("-c, --channel <id>", "Slack channel id, e.g. C0123456789")
    .option("-b, --base <branch>", "branch to cut worktrees from (default: detected)")
    .option("-l, --label <name>", "display name for the repo")
    .action((path: string, options: { channel: string; base?: string; label?: string }) =>
      wrap(() => link(path, options)),
    );

  program
    .command("unlink")
    .description("remove a channel's repo link")
    .requiredOption("-c, --channel <id>", "Slack channel id")
    .action((options: { channel: string }) => wrap(() => unlink(options.channel)));

  program
    .command("list")
    .description("show linked channels and settings")
    .action(() => wrap(list));

  program
    .command("sessions")
    .description("list worktrees ccslack has created")
    .action(() => wrap(sessions));

  program
    .command("clean")
    .description("remove finished worktrees")
    .option("--force", "also remove worktrees with uncommitted changes", false)
    .option("--all", "remove every ccslack worktree, not just merged ones", false)
    .action((options: { force: boolean; all: boolean }) => wrap(() => clean(options)));

  program
    .command("init")
    .description("write a starter config and .env to ~/.ccslack")
    .action(() => wrap(init));

  program
    .command("install-hook")
    .description("add the shell hook that starts Claude when a worktree tab opens")
    .option("--rc <path>", "shell rc file to modify (default: detected)")
    .option("--print", "print the snippet instead of writing it", false)
    .action((options: { rc?: string; print: boolean }) => wrap(() => installHook(options)));

  program
    .command("prompts")
    .description("show the three prompt templates and where to override them")
    .action(() => wrap(prompts));

  program
    .command("doctor")
    .description("check that git, Warp, Claude Code and Slack tokens are all usable")
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

async function start(): Promise<void> {
  await assertGitAvailable();
  const credentials = readCredentials();
  const app = createSlackApp(credentials);

  await app.start();
  const config = await loadConfig();
  const linked = Object.keys(config.channels).length;

  console.log("ccslack is connected to Slack over Socket Mode.");
  console.log(`  config:    ${configFile()}`);
  console.log(`  worktrees: ${config.settings.worktreesRoot}`);
  console.log(`  channels:  ${linked} linked`);
  if (linked === 0) {
    console.log("\nLink a channel by running `/ccslack link ~/path/to/repo` in Slack.");
  }
  console.log("\nUse a message's ⋮ menu to start Investigate, Fix or Review. Ctrl-C to stop.");

  const shutdown = async () => {
    console.log("\nstopping…");
    await app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function link(
  path: string,
  options: { channel: string; base?: string; label?: string },
): Promise<void> {
  const repo = await inspectRepo(expandPath(path));
  await updateConfig((config) => {
    config.channels[options.channel] = {
      repoPath: repo.root,
      baseBranch: options.base ?? "",
      label: options.label ?? "",
      linkedBy: "cli",
      linkedAt: new Date().toISOString(),
    };
  });
  console.log(`Linked ${options.channel} → ${repo.root}`);
  console.log(`Base branch: ${options.base || repo.defaultBranch}${options.base ? "" : " (detected)"}`);
}

async function unlink(channel: string): Promise<void> {
  const existed = await updateConfig((config) => {
    const had = Boolean(config.channels[channel]);
    delete config.channels[channel];
    return had;
  });
  console.log(existed ? `Unlinked ${channel}.` : `${channel} was not linked.`);
}

async function list(): Promise<void> {
  const config = await loadConfig();
  const entries = Object.entries(config.channels);

  console.log(`config: ${configFile()}\n`);
  console.log("settings");
  console.log(`  worktreesRoot:  ${config.settings.worktreesRoot}`);
  console.log(`  warpStrategy:   ${config.settings.warpStrategy}${config.settings.warpPreview ? " (preview)" : ""}`);
  console.log(`  claudeCommand:  ${[config.settings.claudeCommand, ...config.settings.claudeArgs].join(" ")}`);
  console.log(`  threadContext:  ${config.settings.threadContextLimit} messages`);

  console.log("\nlinked channels");
  if (entries.length === 0) {
    console.log("  (none yet — run `/ccslack link ~/path/to/repo` in Slack)");
    return;
  }
  for (const [id, l] of entries) {
    console.log(`  ${id} → ${l.repoPath}`);
    console.log(`      base: ${l.baseBranch || "(detected)"}   label: ${l.label || basename(l.repoPath)}`);
  }
}

async function sessions(): Promise<void> {
  const config = await loadConfig();
  const repos = uniqueRepoPaths(config.channels);
  if (repos.length === 0) {
    console.log("No repos are linked yet.");
    return;
  }

  for (const repoPath of repos) {
    console.log(`\n${repoPath}`);
    const worktrees = (await listWorktrees(repoPath)).filter((w) => !w.isMain);
    if (worktrees.length === 0) {
      console.log("  (no worktrees)");
      continue;
    }
    for (const w of worktrees) {
      console.log(`  ${w.branch}${w.isPrunable ? "  [stale]" : ""}`);
      console.log(`      ${w.path}`);
    }
  }
}

async function clean(options: { force: boolean; all: boolean }): Promise<void> {
  const config = await loadConfig();
  const repos = uniqueRepoPaths(config.channels);
  if (repos.length === 0) {
    console.log("No repos are linked yet.");
    return;
  }

  let removed = 0;
  let kept = 0;

  for (const repoPath of repos) {
    await pruneWorktrees(repoPath);
    const repo = await inspectRepo(repoPath);
    const base = baseBranchFor(config.channels, repoPath) || repo.defaultBranch;

    // Only ever touch worktrees ccslack created, never a worktree the user made
    // by hand elsewhere in the same repo.
    const worktrees = (await listWorktrees(repoPath)).filter(
      (w) => !w.isMain && w.path.startsWith(config.settings.worktreesRoot),
    );

    for (const w of worktrees) {
      if (!options.all && !(await isMergedInto(repoPath, w.branch, base))) {
        console.log(`keep    ${w.branch} — not merged into ${base} (use --all to remove anyway)`);
        kept += 1;
        continue;
      }

      const result = await removeWorktree(repoPath, w.path, {
        force: options.force,
        deleteBranch: config.settings.pruneBranchesOnClean ? w.branch : undefined,
      });

      if (!result.removedWorktree) {
        console.log(`skip    ${w.path} — uncommitted changes (use --force)`);
        kept += 1;
        continue;
      }

      removed += 1;
      console.log(
        result.removedBranch
          ? `removed ${w.branch} and its worktree`
          : `removed worktree for ${w.branch}, kept the branch`,
      );
    }
  }

  console.log(
    `\nRemoved ${removed} worktree${removed === 1 ? "" : "s"}` +
      (kept > 0 ? `, kept ${kept}.` : "."),
  );
}

/** The base branch configured for whichever channel links this repo. */
function baseBranchFor(
  channels: Record<string, { repoPath: string; baseBranch: string }>,
  repoPath: string,
): string {
  for (const link of Object.values(channels)) {
    if (link.repoPath === repoPath && link.baseBranch.trim()) return link.baseBranch.trim();
  }
  return "";
}

async function init(): Promise<void> {
  const root = await ensureConfigRoot();
  const config = await loadConfig();
  await saveConfig(config);

  const env = envFile();
  if (!(await fileExists(env))) {
    await writeFile(
      env,
      [
        "# ccslack credentials. Both tokens come from https://api.slack.com/apps",
        "# Bot token: OAuth & Permissions -> Bot User OAuth Token",
        "SLACK_BOT_TOKEN=xoxb-",
        "# App-level token: Basic Information -> App-Level Tokens (scope: connections:write)",
        "SLACK_APP_TOKEN=xapp-",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    console.log(`Wrote ${env} — fill in both tokens.`);
  } else {
    console.log(`${env} already exists, leaving it alone.`);
  }

  console.log(`Wrote ${configFile()}`);
  console.log(`\nConfig lives in ${root}. Next: fill in the tokens, then run \`ccslack start\`.`);
}

async function installHook(options: { rc?: string; print: boolean }): Promise<void> {
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

  await appendFile(rc, `\n# ccslack\n${sourceLine}\n`, "utf8");
  console.log(`Wrote ${hookPath}`);
  console.log(`Added a source line to ${rc}`);
  console.log("\nOpen a new terminal for it to take effect.");
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
        `Run \`ccslack install-hook --print\` and translate it, or set warpStrategy to "launch_config".`,
      );
    default:
      return join(homedir(), ".zshrc");
  }
}

async function prompts(): Promise<void> {
  const config = await loadConfig();
  for (const { key, prompt } of allPrompts(config)) {
    const overridden = config.prompts[key] !== undefined;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`${prompt.label}  (key: ${key}, branch prefix: ${prompt.branchPrefix}/)`);
    console.log(overridden ? "customised in config.json" : "built-in default");
    console.log("=".repeat(70));
    console.log(prompt.template);
  }
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Override any of these under "prompts" in ${configFile()}.`);
  console.log(`Tokens: ${PROMPT_TOKENS.map((t) => `{{${t}}}`).join(", ")}`);
}

/** Tokens a custom prompt template may use; see src/config/prompts.ts. */
const PROMPT_TOKENS = [
  "author",
  "channel",
  "message",
  "thread",
  "permalink",
  "date",
  "branch",
  "baseBranch",
  "repo",
  "worktree",
] as const;

async function doctor(): Promise<void> {
  const config = await loadConfig();
  let problems = 0;

  const check = (ok: boolean, label: string, detail: string): void => {
    console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
    if (detail) console.log(`       ${detail}`);
    if (!ok) problems += 1;
  };

  console.log("\nccslack doctor\n");

  check(await succeeds("git", ["--version"]), "git", "required to create worktrees");

  const claudeOk = await succeeds(config.settings.claudeCommand, ["--version"]);
  check(
    claudeOk,
    `claude command (${config.settings.claudeCommand})`,
    claudeOk ? "" : "not on PATH — set settings.claudeCommand in config.json",
  );

  const opener = uriOpener();
  check(
    opener !== null,
    `URI opener for ${platform()}`,
    opener ? `${opener.command}` : "no known way to open warp:// links on this platform",
  );

  const warpDir =
    config.settings.warpStrategy === "tab_config"
      ? warpTabConfigDir(config.settings.warpPreview)
      : warpLaunchConfigDir(config.settings.warpPreview);
  console.log(`  ok   warp strategy: ${config.settings.warpStrategy}`);
  console.log(`       writes to ${warpDir}`);

  const hookInstalled = await fileExists(shellHookFile());
  console.log(`  ${hookInstalled ? "ok " : "-- "}  shell hook`);
  console.log(
    hookInstalled
      ? `       installed at ${shellHookFile()}`
      : `       not installed. Run \`ccslack install-hook\` so sessions start even when Warp ignores the launch config.`,
  );

  try {
    const credentials = readCredentials();
    check(true, "Slack tokens", `read from ${envFile()}`);
    try {
      const identity = await verifyCredentials(credentials);
      check(true, "Slack authentication", `connected as ${identity.bot} in ${identity.team}`);
    } catch (err) {
      check(
        false,
        "Slack authentication",
        `${describeError(err).message} — reinstall the app, or regenerate the bot token`,
      );
    }
  } catch (err) {
    check(false, "Slack tokens", describeError(err).message);
  }

  const channels = Object.entries(config.channels);
  console.log(`\n  linked channels: ${channels.length}`);
  for (const [id, l] of channels) {
    try {
      const repo = await inspectRepo(l.repoPath);
      console.log(`  ok   ${id} → ${repo.root}`);
    } catch (err) {
      console.log(` FAIL  ${id} → ${l.repoPath}`);
      console.log(`       ${describeError(err).message}`);
      problems += 1;
    }
  }

  console.log(
    problems === 0
      ? "\nEverything checks out. Run `ccslack start`.\n"
      : `\n${problems} problem${problems === 1 ? "" : "s"} to fix.\n`,
  );
  if (problems > 0) process.exitCode = 1;
}

function uniqueRepoPaths(channels: Record<string, { repoPath: string }>): string[] {
  return [...new Set(Object.values(channels).map((l) => l.repoPath))];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
