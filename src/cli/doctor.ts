import { agentDefinition, describeHeadless, resolveAgent } from "../agents/agents.js";
import { findSlackApp, inspectDebugPort, isSlackRunning } from "../cdp/launch.js";
import { shellHookFile } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { loadConfig } from "../config/store.js";
import { inspectRepo } from "../git/repo.js";
import { tmuxHasSessionArgv, TMUX_FALLBACK_SESSION } from "../terminals/commands.js";
import { findTerminalApp, terminalDefinition } from "../terminals/registry.js";
import { buildOutOfDate, depsOutOfDate, installRoot } from "../update.js";
import { describeError } from "../util/errors.js";
import { run, succeeds } from "../util/exec.js";
import { platform, uriOpener, warpLaunchConfigDir, warpTabConfigDir } from "../util/platform.js";
import { strategyOrder } from "../warp/launcher.js";
import { pileUpNudge, plural, terminalSummary } from "./shared.js";
import { exists } from "../util/fs.js";

/**
 * Whether one of these apps is installed; null where there is no way to ask.
 * `open -Ra` finds an app by name without launching it.
 */
async function appInstalled(names: string[]): Promise<boolean | null> {
  if (platform() !== "darwin") return null;
  for (const name of names) {
    if (await succeeds("open", ["-Ra", name])) return true;
  }
  return false;
}

/** One line of the doctor's report: a check that passed or failed, or something worth knowing. */
export interface CheckRow {
  status: "ok" | "fail" | "info";
  label: string;
  detail: string;
  /** Rows after this one belong under this heading, for the printed report. */
  section?: string;
}

/** Print the checks and say how many problems there are; the exit code says the same. */
export async function doctor(): Promise<void> {
  console.log("\nsidequest doctor\n");
  const rows = await runChecks(await loadConfig());
  for (const row of rows) {
    if (row.section) console.log(`\n  ${row.section}`);
    const mark = row.status === "ok" ? "  ok  " : row.status === "fail" ? " FAIL " : "  --  ";
    console.log(`${mark} ${row.label}`);
    if (row.detail) console.log(`       ${row.detail}`);
  }
  const problems = rows.filter((r) => r.status === "fail").length;
  console.log(
    problems === 0
      ? "\nEverything checks out. Run `sidequest start`.\n"
      : `\n${plural(problems, "problem")} to fix.\n`,
  );
  if (problems > 0) process.exitCode = 1;
}

/**
 * Everything doctor looks at, as rows rather than printed lines, so the Mac
 * app can show the same checks as the terminal.
 */
export async function runChecks(config: Config): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const check = (ok: boolean, label: string, detail: string): void => {
    rows.push({ status: ok ? "ok" : "fail", label, detail });
  };
  const note = (ok: boolean, label: string, detail: string): void => {
    rows.push({ status: ok ? "ok" : "info", label, detail });
  };

  check(await succeeds("git", ["--version"]), "git", "required to create worktrees");

  const agent = resolveAgent(config.settings.agent, config.settings);
  if (agent.app) {
    const installed = await appInstalled(agent.app.appNames);
    if (installed === null) {
      note(false, `${agent.label} in ${agent.host}`, `can't check for the app on ${platform()}. ${agentDefinition(agent.id).installHint}`);
    } else {
      check(installed, `${agent.label} in ${agent.host}`, installed ? "" : agentDefinition(agent.id).installHint);
    }
  } else {
    const agentOk = await succeeds(agent.command, ["--version"]);
    check(
      agentOk,
      `${agent.label} (${agent.command})`,
      agentOk ? "" : agentDefinition(agent.id).installHint,
    );
  }

  if (config.settings.trackStatus) {
    const gh = await succeeds("gh", ["auth", "status"]);
    note(
      gh,
      "gh",
      gh
        ? "signed in, so each session's mark follows its pull request"
        : "not installed or not signed in (optional). Without it, a session's mark stops at its commits.",
    );
  }

  if (agent.app) {
    // The app's own links need the opener; no terminal is involved.
    const opener = uriOpener();
    check(
      opener !== null,
      `URI opener for ${platform()}`,
      opener ? `${opener.command}` : `no known way to open ${agent.host}'s links on this platform`,
    );
    note(false, `terminal: ${terminalSummary(config.settings.terminal, agent)}`, "");
  } else if (config.settings.terminal === "warp") {
    const opener = uriOpener();
    check(
      opener !== null,
      `URI opener for ${platform()}`,
      opener ? `${opener.command}` : "no known way to open warp:// links on this platform",
    );

    const order = strategyOrder(config.settings.warpStrategy);
    const dirs = [
      order.includes("tab_config") ? `tab configs in ${warpTabConfigDir(config.settings.warpPreview)}` : "",
      order.includes("launch_config") ? `launch configs in ${warpLaunchConfigDir(config.settings.warpPreview)}` : "",
    ].filter(Boolean);
    note(true, `warp strategy: ${config.settings.warpStrategy} (tries ${order.join(" → ")})`, dirs.join("\n       "));

    const hookInstalled = await exists(shellHookFile());
    note(
      hookInstalled,
      "shell hook",
      hookInstalled
        ? `installed at ${shellHookFile()}`
        : "not installed. Run `sidequest install-hook` so sessions start even when Warp ignores the launch config.",
    );
  } else {
    await doctorTerminal(config, check, note);
  }

  const root = installRoot();
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: root }).then((r) => r.stdout.trim(), () => "");
  if (head) {
    const stale = (await buildOutOfDate(root, head)) || (await depsOutOfDate(root));
    note(
      !stale,
      "install",
      stale
        ? `the build in ${root} doesn't match its checkout. Run \`sidequest update\`.`
        : `built from ${head.slice(0, 7)}; \`sidequest update\` pulls the latest`,
    );
  }

  const app = findSlackApp();
  check(
    app !== null,
    "Slack desktop app",
    app ?? "not found in /Applications or ~/Applications",
  );

  const port = await inspectDebugPort(config.settings.cdpPort, config.settings.targetUrlPattern);
  const slackUp = await isSlackRunning();
  if (port.open && !port.isSlack) {
    // An open port is not the same as an attachable Slack: whatever answers
    // here is what `sidequest start` would drive.
    check(
      false,
      `Slack DevTools port ${config.settings.cdpPort}`,
      `open, but ${port.browser || "something"} is on it, not Slack. Quit that app, or set ` +
        "settings.cdpPort to a free port and run `sidequest start --force`.",
    );
  } else if (port.open) {
    check(
      port.matchingTargets > 0,
      `Slack DevTools port ${config.settings.cdpPort}`,
      port.matchingTargets > 0
        ? `open — ${plural(port.matchingTargets, "Slack window")} to attach to`
        : `open, but no window matches /${config.settings.targetUrlPattern}/ ` +
          `(${plural(port.totalTargets, "target")} seen). ` +
          "Open a workspace in Slack, or widen settings.targetUrlPattern.",
    );
  } else if (slackUp) {
    check(
      false,
      `Slack DevTools port ${config.settings.cdpPort}`,
      "Slack is running without it. Slack only accepts the flag at startup — " +
        "quit Slack, or run `sidequest start --force` to restart it.",
    );
  } else {
    note(false, `Slack DevTools port ${config.settings.cdpPort}`, "Slack is not running. `sidequest start` will launch it with the port open.");
  }

  const channels = Object.entries(config.channels);
  let section: string | undefined = `linked channels: ${channels.length}`;
  for (const [id, l] of channels.flatMap(([id, links]) => links.map((l) => [id, l] as const))) {
    try {
      const repo = await inspectRepo(l.repoPath);
      rows.push({ status: "ok", label: `${id} → ${repo.root}`, detail: "", section });
    } catch (err) {
      rows.push({ status: "fail", label: `${id} → ${l.repoPath}`, detail: describeError(err).message, section });
    }
    section = undefined;
  }

  // Not a problem, so it doesn't fail the check; just worth knowing.
  const pile = await pileUpNudge(config);
  if (pile) {
    rows.push({ status: "info", label: "worktrees", detail: pile, section: section ?? "" });
  } else if (config.settings.autoClean) {
    rows.push({
      status: "ok",
      label: `worktrees: auto-clean removes merged ones idle over ${config.settings.autoCleanAfterDays} days`,
      detail: "",
      section: section ?? "",
    });
  }
  return rows;
}

/** Doctor's checks for every terminal but Warp, which has its own above. */
async function doctorTerminal(
  config: Config,
  check: (ok: boolean, label: string, detail: string) => void,
  note: (ok: boolean, label: string, detail: string) => void,
): Promise<void> {
  const id = config.settings.terminal;
  const def = terminalDefinition(id);
  const onMac = platform() === "darwin";

  switch (id) {
    case "iterm2":
    case "terminal": {
      const app = onMac ? findTerminalApp(id) : null;
      check(
        app !== null,
        `terminal: ${def.label}`,
        !onMac
          ? `only on macOS. Pick another with \`sidequest terminal\`.`
          : app
            ? `${app}. The first session asks to let Sidequest control it; allow it under ` +
              "System Settings → Privacy & Security → Automation."
            : def.installHint,
      );
      if (app) check(await succeeds("osascript", ["-e", "return"]), "osascript", "drives the terminal over AppleScript");
      return;
    }
    case "ghostty": {
      const app = onMac ? findTerminalApp(id) : null;
      const ok = onMac ? app !== null : await succeeds("ghostty", ["--version"]);
      check(ok, `terminal: ${def.label}`, ok ? (app ?? "ghostty on PATH") + " (1.2 or later)" : def.installHint);
      return;
    }
    case "tmux": {
      const ok = await succeeds("tmux", ["-V"]);
      check(ok, `terminal: ${def.label}`, ok ? "" : def.installHint);
      if (!ok) return;
      const target = config.settings.tmuxSession.trim();
      const has = tmuxHasSessionArgv(target);
      const running = await succeeds(has.command, has.args);
      note(
        running,
        `tmux session${target ? ` "${target}"` : ""}`,
        running
          ? `sessions open as new windows in ${target ? `"${target}"` : "the session you used last"}`
          : `none running, so the first session starts a detached "${target || TMUX_FALLBACK_SESSION}" session to attach to`,
      );
      return;
    }
    case "headless": {
      const agent = resolveAgent(config.settings.agent, config.settings);
      check(
        agent.headless !== undefined,
        `terminal: ${def.label}`,
        agent.headless
          ? `runs ${describeHeadless(agent)}; ` +
            "logs to .sidequest/agent.log, answers in .sidequest/result.md"
          : `${agent.label} has no headless mode. Switch with \`sidequest agents\` or \`sidequest terminal\`.`,
      );
      return;
    }
    case "warp":
      return;
  }
}
