import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const calls: Array<{ command: string; args: string[] }> = [];
let onRun: (command: string, args: string[]) => Promise<void> = async () => {};
let hasTmuxSession = true;
let currentPlatform: "darwin" | "linux" = "darwin";

vi.mock("../src/util/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    // git is real, for the createSession test; terminals are recorded.
    run: vi.fn(async (command: string, args: string[], options?: Parameters<typeof actual.run>[2]) => {
      if (command === "git") return actual.run(command, args, options);
      calls.push({ command, args });
      await onRun(command, args);
      return { stdout: "", stderr: "" };
    }),
    succeeds: vi.fn(async (command: string, args: string[], options?: Parameters<typeof actual.run>[2]) => {
      if (command === "git") return actual.succeeds(command, args, options);
      calls.push({ command, args });
      return command === "tmux" && args[0] === "has-session" ? hasTmuxSession : true;
    }),
  };
});

vi.mock("../src/util/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/platform.js")>();
  return {
    ...actual,
    platform: () => currentPlatform,
    uriOpener: () => ({ command: "open", args: [] }),
    warpLaunchConfigDir: () => join(root, "launch"),
    warpTabConfigDir: () => join(root, "tabs"),
  };
});

const {
  ghosttyArgv,
  iterm2Argv,
  keepShellArgv,
  terminalAppArgv,
  tmuxHasSessionArgv,
  tmuxNewSessionArgv,
  tmuxNewWindowArgv,
} = await import("../src/terminals/commands.js");
const { launchTerminal, agentDidNotStart } = await import("../src/terminals/launch.js");
const { renderHeadlessScript, writeHeadlessRunner, headlessPaths } = await import("../src/terminals/headless.js");
const { writeAutorun } = await import("../src/warp/autorun.js");
const { settingsSchema } = await import("../src/config/schema.js");
const { AGENT_DEFINITIONS, resolveAgent } = await import("../src/agents/agents.js");
const { TERMINAL_DEFINITIONS } = await import("../src/terminals/registry.js");

const execFileAsync = promisify(execFile);

let root: string;
let pendingFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-terminals-"));
  pendingFile = join(root, "pending");
  await writeFile(pendingFile, "");
  calls.length = 0;
  onRun = async () => {};
  hasTmuxSession = true;
  currentPlatform = "darwin";
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const spec = { cwd: "/w/it's here", script: "/w/it's here/.sidequest/autorun.sh", title: "Fix · repo" };

/** The AppleScript source, which must not contain anything session-specific. */
function scriptSource(args: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "-e") lines.push(args[++i]!);
  return lines.join("\n");
}

describe("macOS terminal commands", () => {
  it("drives iTerm2 through osascript, with paths as argv, not script text", () => {
    const argv = iterm2Argv(spec);
    expect(argv.command).toBe("osascript");
    expect(argv.args.slice(-2)).toEqual([spec.cwd, spec.script]);
    const source = scriptSource(argv.args);
    expect(source).toContain("on run argv");
    expect(source).toContain("quoted form of (item 1 of argv)");
    expect(source).toContain("quoted form of (item 2 of argv)");
    expect(source).toContain('tell application id "com.googlecode.iterm2"');
    expect(source).toContain("create tab with default profile");
    expect(source).toContain("write text cmd");
    expect(source).not.toContain("it's here");
  });

  it("drives Terminal.app with do script", () => {
    const argv = terminalAppArgv(spec);
    expect(argv.command).toBe("osascript");
    expect(argv.args.slice(-2)).toEqual([spec.cwd, spec.script]);
    const source = scriptSource(argv.args);
    expect(source).toContain('tell application id "com.apple.Terminal"');
    expect(source).toContain("do script cmd");
    expect(source).not.toContain("it's here");
  });

  it("just changes directory when there is no script", () => {
    const argv = iterm2Argv({ ...spec, script: null });
    expect(argv.args.at(-1)).toBe(spec.cwd);
    expect(argv.args).not.toContain(spec.script);
  });

  it("opens a new Ghostty instance on macOS, and ghostty itself elsewhere", () => {
    expect(ghosttyArgv(spec, true)).toEqual({
      command: "open",
      args: ["-na", "Ghostty.app", "--args", `--working-directory=${spec.cwd}`, "-e", ...keepShellArgv(spec.script)],
    });
    expect(ghosttyArgv({ ...spec, script: null }, false)).toEqual({
      command: "ghostty",
      args: [`--working-directory=${spec.cwd}`],
    });
  });
});

describe("tmux commands", () => {
  it("adds a window to the session used last, or the one named", () => {
    expect(tmuxNewWindowArgv({ ...spec, session: "" })).toEqual({
      command: "tmux",
      args: ["new-window", "-c", spec.cwd, "-n", spec.title, "--", ...keepShellArgv(spec.script)],
    });
    expect(tmuxNewWindowArgv({ ...spec, script: null, session: "work" }).args).toEqual([
      "new-window", "-t", "=work:", "-c", spec.cwd, "-n", spec.title,
    ]);
  });

  it("starts a detached session when there is none", () => {
    expect(tmuxNewSessionArgv({ ...spec, session: "" }).args.slice(0, 4)).toEqual(["new-session", "-d", "-s", "sidequest"]);
    expect(tmuxNewSessionArgv({ ...spec, session: "work" }).args.slice(0, 4)).toEqual(["new-session", "-d", "-s", "work"]);
    expect(tmuxHasSessionArgv("work").args).toEqual(["has-session", "-t", "=work"]);
    expect(tmuxHasSessionArgv("").args).toEqual(["has-session"]);
  });
});

describe("keepShellArgv", () => {
  it("runs the script as one argument, then hands over to the shell", async () => {
    const dir = join(root, "a dir with 'quotes' and $(spaces)");
    await execFileAsync("mkdir", ["-p", dir]);
    const script = join(dir, "autorun.sh");
    await writeFile(script, `#!/usr/bin/env bash\necho ran > "${root}/ran"\n`);
    await chmod(script, 0o755);
    const [command, ...args] = keepShellArgv(script);
    const { stdout } = await execFileAsync(command!, args, {
      env: { ...process.env, SHELL: "/bin/echo" },
    });
    expect(await readFile(join(root, "ran"), "utf8")).toBe("ran\n");
    // exec "$SHELL" -l: with SHELL=/bin/echo, that prints "-l".
    expect(stdout.trim()).toBe("-l");
  });
});

describe("launchTerminal", () => {
  const session = () => ({
    name: "sidequest-test",
    color: "blue" as const,
    title: "Fix · repo",
    cwd: root,
    script: join(root, "autorun.sh"),
    pendingFile,
  });

  it("keeps Warp on its own launcher, opening a plain tab with nothing to run", async () => {
    await rm(pendingFile);
    const settings = settingsSchema.parse({});
    expect(settings.terminal).toBe("warp");
    const result = await launchTerminal({ settings, session: { ...session(), script: null } });
    expect(result).toMatchObject({ terminal: "warp", strategy: "new_tab" });
    expect(calls.at(-1)!.args.at(-1)).toMatch(/^warp:\/\/action\/new_tab\?path=/);
  });

  it("opens iTerm2 and waits for the agent to claim the session", async () => {
    onRun = async () => rm(pendingFile);
    const result = await launchTerminal({ settings: settingsSchema.parse({ terminal: "iterm2" }), session: session() });
    expect(result).toMatchObject({ terminal: "iterm2", agentStarted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("osascript");
  });

  it("reports when Terminal opened but nothing ran", async () => {
    const result = await launchTerminal({
      settings: settingsSchema.parse({ terminal: "terminal" }),
      session: session(),
      claimTimeoutMs: 100,
    });
    expect(result.agentStarted).toBe(false);
    expect(agentDidNotStart("terminal")).toContain("Terminal opened but the agent did not start");
  });

  it("refuses the AppleScript terminals off macOS", async () => {
    currentPlatform = "linux";
    await expect(
      launchTerminal({ settings: settingsSchema.parse({ terminal: "iterm2" }), session: session() }),
    ).rejects.toThrow(/only on macOS/);
  });

  it("uses open -na for Ghostty on macOS", async () => {
    onRun = async () => rm(pendingFile);
    await launchTerminal({ settings: settingsSchema.parse({ terminal: "ghostty" }), session: session() });
    expect(calls[0]!.command).toBe("open");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-na", "Ghostty.app", "--args"]);
  });

  it("adds a tmux window when a session is running", async () => {
    onRun = async () => rm(pendingFile);
    const result = await launchTerminal({
      settings: settingsSchema.parse({ terminal: "tmux", tmuxSession: "work" }),
      session: session(),
    });
    expect(result).toMatchObject({ strategy: "tmux window", agentStarted: true });
    expect(calls.map((c) => c.args[0])).toEqual(["has-session", "new-window"]);
  });

  it("starts a detached tmux session when none is running, and says how to attach", async () => {
    hasTmuxSession = false;
    onRun = async () => rm(pendingFile);
    const result = await launchTerminal({ settings: settingsSchema.parse({ terminal: "tmux" }), session: session() });
    expect(result.strategy).toBe("tmux session");
    expect(result.note).toContain("tmux attach -t sidequest");
    expect(calls.map((c) => c.args[0])).toEqual(["has-session", "new-session"]);
  });

  it("does not wait when the session was already claimed", async () => {
    await rm(pendingFile);
    const result = await launchTerminal({ settings: settingsSchema.parse({ terminal: "iterm2" }), session: session() });
    expect(result.agentStarted).toBeNull();
  });

  it("opens a finished headless session's answer instead of running it again", async () => {
    await rm(pendingFile);
    const files = headlessPaths(root);
    await execFileAsync("mkdir", ["-p", join(root, ".sidequest")]);
    await writeFile(files.resultFile, "done\n");
    const result = await launchTerminal({ settings: settingsSchema.parse({ terminal: "headless" }), session: session() });
    expect(result).toMatchObject({ terminal: "headless", agentStarted: null });
    expect(calls).toEqual([{ command: "open", args: [files.resultFile] }]);
  });
});

describe("headless runs", () => {
  const PROMPT = "Fix this: $(touch pwned) `touch pwned2` 'quoted' \"double\"";

  /** A stand-in agent: progress on stderr, the answer on stdout. */
  async function fakeAgent(body: string): Promise<string> {
    const path = join(root, "agent.sh");
    await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  async function finished(logFile: string): Promise<string> {
    for (let i = 0; i < 200; i += 1) {
      const text = await readFile(logFile, "utf8").catch(() => "");
      if (text.includes("sidequest: finished")) return text;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the headless run never finished");
  }

  async function runHeadless(agentCommand: string, headless: { args: string[]; result: "stdout" | "file" }) {
    const worktree = join(root, "wt");
    const files = await writeAutorun({ worktreePath: worktree, prompt: PROMPT, agentCommand, agentArgs: [] });
    const runner = await writeHeadlessRunner({ worktreePath: worktree, agentCommand, agentArgs: ["--mine"], headless });
    const result = await launchTerminal({
      settings: settingsSchema.parse({ terminal: "headless" }),
      session: { name: "x", color: "blue", title: "x", cwd: worktree, script: runner.scriptFile, pendingFile: files.pendingFile },
    });
    expect(result).toMatchObject({ terminal: "headless", agentStarted: true });
    return { worktree, runner, log: await finished(runner.logFile) };
  }

  it("saves stdout as the answer and logs the rest", async () => {
    const agent = await fakeAgent(`echo "working" >&2\nprintf 'args:%s\\n' "$@"`);
    const { worktree, runner, log } = await runHeadless(agent, { args: ["-p"], result: "stdout" });
    const result = await readFile(runner.resultFile, "utf8");
    // Headless flags, then the user's args, then the prompt as one argument.
    expect(result).toBe(`args:-p\nargs:--mine\nargs:${PROMPT}\n`);
    expect(log).toContain("working");
    expect(log).toMatch(/exit 0/);
    await expect(stat(join(worktree, "pwned"))).rejects.toThrow();
    await expect(stat(join(worktree, "pwned2"))).rejects.toThrow();
  });

  it("leaves no answer when the agent fails", async () => {
    const agent = await fakeAgent(`echo "half an answer"\necho "broke" >&2\nexit 3`);
    const { runner, log } = await runHeadless(agent, { args: [], result: "stdout" });
    expect(log).toMatch(/exit 3/);
    await expect(stat(runner.resultFile)).rejects.toThrow();
    await expect(stat(`${runner.resultFile}.partial`)).rejects.toThrow();
  });

  it("lets an agent that writes its own answer do so, logging all of its output", async () => {
    const agent = await fakeAgent(`echo "step 1"\nprintf 'final' > "$2"`);
    const { runner, log } = await runHeadless(agent, { args: ["--out", ".sidequest/result.md"], result: "file" });
    expect(await readFile(runner.resultFile, "utf8")).toBe("final");
    expect(log).toContain("step 1");
  });

  it("quotes every argument in the script", () => {
    const script = renderHeadlessScript({
      worktreePath: "/w",
      agentCommand: "/opt/my agent",
      agentArgs: ["it's"],
      headless: { args: ["-p"], result: "stdout" },
    });
    expect(script).toContain(`'/opt/my agent' '-p' 'it'\\''s' "$(cat "$session_dir/prompt.md")"`);
  });

  it("hands the prompt over the way the headless mode takes it", () => {
    const script = renderHeadlessScript({
      worktreePath: "/w",
      agentCommand: "gemini",
      agentArgs: ["--model", "pro"],
      headless: { args: [], promptArgs: ["-p", "{prompt}"], result: "stdout" },
    });
    expect(script).toContain(`'gemini' '--model' 'pro' '-p' "$(cat "$session_dir/prompt.md")" </dev/null`);
  });
});

describe("registries", () => {
  it("gives the agents with a clean non-interactive mode a headless invocation, and only those", () => {
    const withHeadless = AGENT_DEFINITIONS.filter((d) => d.headless).map((d) => d.id);
    expect(withHeadless).toEqual(["claude", "codex", "gemini", "cursor-agent", "qwen"]);
    // Desktop-app agents never run in a terminal, so they have none.
    expect(AGENT_DEFINITIONS.filter((d) => d.app && d.headless)).toEqual([]);
    for (const id of withHeadless) {
      const agent = resolveAgent({ id, command: "", args: [] });
      if (agent.headless!.result === "file") expect(agent.headless!.args).toContain(".sidequest/result.md");
    }
    expect(resolveAgent({ id: "claude", command: "", args: [] }).headless!.args[0]).toBe("-p");
    expect(resolveAgent({ id: "codex", command: "", args: [] }).headless!.args[0]).toBe("exec");
  });

  it("lists every terminal the setting accepts", () => {
    expect(TERMINAL_DEFINITIONS.map((d) => d.id)).toEqual(["warp", "iterm2", "ghostty", "terminal", "tmux", "headless"]);
  });
});

describe("createSession, headless", () => {
  it("cuts the worktree and runs the agent in the background, answering in result.md", async () => {
    const { configSchema } = await import("../src/config/schema.js");
    const { createSession } = await import("../src/session/create.js");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const repoPath = join(root, "repo");
    await execFileAsync("mkdir", ["-p", repoPath]);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoPath });
    await writeFile(join(repoPath, "README.md"), "# test\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath, env: gitEnv });

    const agent = join(root, "claude.sh");
    // Claude's headless flags come first; the answer is on stdout.
    await writeFile(agent, `#!/usr/bin/env bash\n[ "$1" = "-p" ] || exit 9\necho "The answer."\n`);
    await chmod(agent, 0o755);

    const config = configSchema.parse({
      settings: {
        terminal: "headless",
        agent: { id: "claude", command: agent },
        worktreesRoot: join(root, "worktrees"),
        fetchBeforeCreate: false,
      },
      channels: { eng: [{ repoPath, channel: "eng" }] },
    });
    const result = await createSession(
      "investigate",
      { channelName: "eng", authorName: "sam", text: "Why is it slow?", ts: "1700000000.000100", permalink: "", threadMessages: [] },
      config,
    );
    expect(result).toMatchObject({ host: "the background", launchStrategy: "headless" });
    expect(result.launchError).toBeUndefined();
    // Nothing was handed to a terminal or the URI opener.
    expect(calls).toEqual([]);

    const files = headlessPaths(result.worktreePath);
    for (let i = 0; i < 200 && !(await stat(files.resultFile).catch(() => null)); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await readFile(files.resultFile, "utf8")).toBe("The answer.\n");
  });

  it("runs an agent's own promptArgs and resumeArgs in any terminal, via autorun.sh", async () => {
    const { configSchema } = await import("../src/config/schema.js");
    const { createSession } = await import("../src/session/create.js");
    const repoPath = join(root, "repo2");
    await execFileAsync("mkdir", ["-p", repoPath]);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoPath });
    await writeFile(join(repoPath, "README.md"), "# test\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "i"], { cwd: repoPath });

    const config = configSchema.parse({
      settings: { terminal: "tmux", agent: { id: "aider" }, worktreesRoot: join(root, "wt2"), fetchBeforeCreate: false },
      channels: { eng: [{ repoPath, channel: "eng" }] },
    });
    // Aider can't run headless, so it is refused there before any worktree is cut.
    await expect(
      createSession("fix", { channelName: "eng", authorName: "a", text: "x", ts: "1", permalink: "", threadMessages: [] },
        configSchema.parse({ ...config, settings: { ...config.settings, terminal: "headless" } })),
    ).rejects.toThrow(/Aider has no headless mode/);

    onRun = async (command, args) => {
      if (command === "tmux" && args[0] === "new-window") await rm(join(args[args.indexOf("-c") + 1]!, ".sidequest", "pending"));
    };
    const result = await createSession(
      "fix",
      { channelName: "eng", authorName: "a", text: "Broken", ts: "1700000000.000100", permalink: "", threadMessages: [] },
      config,
    );
    expect(result.launchError).toBeUndefined();
    const script = join(result.worktreePath, ".sidequest", "autorun.sh");
    expect(calls.at(-1)!.args.at(-1)).toBe(script);
    const body = await readFile(script, "utf8");
    expect(body).toContain(`'aider' '--message-file' "$session_dir/prompt.md"`);
    expect(body).toContain(`'aider' '--restore-chat-history'`);
  });
});
