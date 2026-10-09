import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Approvals } from "../src/control/approvals.js";
import { answerMessage, decide } from "../src/cli/mcpApprove.js";
import { configSchema } from "../src/config/schema.js";
import { claudeItems, logItems, readTranscript, summarizeTool } from "../src/session/transcript.js";
import { changedFiles, fileDiff, runState, stopRun, terminalCommand } from "../src/session/workspace.js";
import { pidExists } from "../src/util/lockfile.js";

const exec = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sq-workspace-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const line = (event: unknown) => JSON.stringify(event);

describe("the conversation of a headless run", () => {
  // Shaped like Claude Code's stream-json, with the runner's markers around each run.
  const stream = [
    line({ type: "sidequest", event: "run-start", mode: "first", prompt: "# Fix\n\nthe whole prompt" }),
    line({ type: "system", subtype: "init", session_id: "s1", tools: ["Bash"] }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the cart." }, { type: "tool_use", name: "Read", input: { file_path: "src/cart.ts" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test -- cart\nmore" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "1 failing" }] }] } }),
    line({ type: "rate_limit_event", rate_limit_info: {} }),
    line({ type: "result", subtype: "success", result: "Fixed it." }),
    line({ type: "sidequest", event: "run-end", status: 0 }),
    line({ type: "sidequest", event: "run-start", mode: "followup", prompt: "# Follow-up from Slack (#eng)\n\nAlso check the email.\n\n## When you are done\n…" }),
    line({ type: "result", subtype: "error_max_turns", errors: ["Reached the turn limit"] }),
    line({ type: "sidequest", event: "run-end", status: 1 }),
    "not json at all",
  ].join("\n");

  it("shows what the agent said and did, what you asked, and how each run ended", () => {
    expect(claudeItems(stream)).toEqual([
      { kind: "agent", text: "Looking at the cart." },
      { kind: "tool", tool: "Read", text: "src/cart.ts" },
      { kind: "tool", tool: "Bash", text: "npm test -- cart" },
      { kind: "error", text: "1 failing" },
      { kind: "done", text: "Finished." },
      { kind: "you", text: "Also check the email." },
      { kind: "error", text: "Reached the turn limit" },
      { kind: "error", text: "The agent stopped with exit code 1." },
      { kind: "log", text: "not json at all" },
    ]);
  });

  it("names what a tool was asked to do in one line", () => {
    expect(summarizeTool("WebFetch", { url: "https://x.test", prompt: "read" })).toBe("https://x.test");
    expect(summarizeTool("Custom", { a: 1 })).toBe('{"a":1}');
    expect(summarizeTool("Custom", {})).toBe("Custom");
  });

  it("falls back to the log for an agent with no event stream", async () => {
    await mkdir(join(root, ".sidequest"), { recursive: true });
    await writeFile(join(root, ".sidequest", "agent.log"), "sidequest: started 2026\nthinking\nsidequest: finished, exit 0\n");
    expect(await readTranscript(root)).toEqual({
      structured: false,
      items: [{ kind: "log", text: "thinking" }, { kind: "log", text: "sidequest: finished, exit 0" }],
    });
    expect(logItems("")).toEqual([]);
  });
});

describe("approvals", () => {
  function broker(canAsk = true) {
    const changes: Array<{ asked?: { id: string }; settled?: string }> = [];
    const approvals = new Approvals({ canAsk: () => canAsk, onChange: (c) => changes.push(c), timeoutMs: 200 });
    const ask = () => approvals.request({ branch: "b", worktreePath: "/wt", title: "Fix it", tool: "Bash", input: { command: "npm test" } });
    return { approvals, changes, ask };
  }

  it("asks, and answers with what you said", async () => {
    const { approvals, changes, ask } = broker();
    const answer = ask();
    expect(approvals.pending).toMatchObject([{ tool: "Bash", summary: "npm test", title: "Fix it" }]);
    approvals.decide(changes[0]!.asked!.id, true);
    expect(await answer).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(approvals.pending).toEqual([]);
    expect(changes.at(-1)).toEqual({ settled: changes[0]!.asked!.id });
  });

  it("remembers always-allow for the session, and says no when you do", async () => {
    const { approvals, changes, ask } = broker();
    const first = ask();
    approvals.decide(changes[0]!.asked!.id, true, true);
    await first;
    expect(await ask()).toMatchObject({ behavior: "allow" });
    expect(approvals.pending).toEqual([]);

    const other = approvals.request({ branch: "c", worktreePath: "/other", title: "x", tool: "Bash", input: {} });
    approvals.decide(approvals.pending[0]!.id, false);
    expect(await other).toMatchObject({ behavior: "deny" });
  });

  it("says no when there is nobody to ask, or nobody answers", async () => {
    expect(await broker(false).ask()).toMatchObject({ behavior: "deny", message: expect.stringContaining("isn't open") });
    expect(await broker().ask()).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nobody answered") });
  });
});

describe("sidequest mcp-approve", () => {
  it("speaks enough MCP to offer one tool and answer it as Claude Code expects", async () => {
    const init = await answerMessage({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, "/wt");
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect(await answerMessage({ method: "notifications/initialized" }, "/wt")).toBeNull();
    const tools = (await answerMessage({ id: 2, method: "tools/list" }, "/wt")) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((t) => t.name)).toEqual(["approve"]);

    let asked: Record<string, unknown> = {};
    const ask = async (payload: Record<string, unknown>) => {
      asked = payload;
      return { ok: true, decision: { behavior: "allow", updatedInput: { command: "ls" } } };
    };
    const call = (await answerMessage(
      { id: 3, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } } },
      "/wt",
      ask,
    )) as { result: { content: Array<{ text: string }> } };
    expect(asked).toEqual({ op: "approval-request", worktree: "/wt", tool: "Bash", input: { command: "ls" } });
    expect(JSON.parse(call.result.content[0]!.text)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(await answerMessage({ id: 4, method: "resources/list" }, "/wt")).toMatchObject({ error: { code: -32601 } });
  });

  it("says no when the daemon cannot be reached", async () => {
    const unreachable = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await decide("/wt", "Bash", {}, unreachable)).toMatchObject({ behavior: "deny" });
  });
});

describe("a session's workspace", () => {
  async function git(args: string[], cwd: string) {
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd });
  }

  it("lists what the session changed since its base, committed or not, and diffs a file", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(["init", "--initial-branch=main"], repo);
    await writeFile(join(repo, "a.txt"), "one\n");
    await writeFile(join(repo, "gone.txt"), "bye\n");
    await git(["add", "."], repo);
    await git(["commit", "-m", "base"], repo);
    const wt = join(root, "wt");
    await git(["worktree", "add", "-b", "claude/fix", wt, "main"], repo);
    await writeFile(join(wt, "a.txt"), "one\ntwo\n");
    await git(["commit", "-am", "two"], wt);
    await rm(join(wt, "gone.txt"));
    await writeFile(join(wt, "new.txt"), "fresh\n");

    const config = configSchema.parse({ channels: { eng: [{ repoPath: repo, channel: "eng", baseBranch: "main" }] } });
    const { files } = await changedFiles(config, repo, wt);
    expect(files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.txt", added: 1, removed: 0, status: "modified" },
      { path: "gone.txt", added: 0, removed: 1, status: "deleted" },
      { path: "new.txt", added: 1, removed: 0, status: "added" },
    ]);
    expect(await fileDiff(config, repo, wt, "a.txt")).toContain("+two");
    expect(await fileDiff(config, repo, wt, "new.txt")).toContain("+fresh");
  });

  it("knows a headless run is going, and stops it with its agent", async () => {
    await mkdir(join(root, ".sidequest"), { recursive: true });
    expect(await runState(root)).toEqual({ headless: false, running: false });
    await writeFile(join(root, ".sidequest", "headless.sh"), "#!/bin/sh\n");
    // A runner leading its own process group, with an agent under it.
    const runner = spawn("bash", ["-c", `echo $$ > .sidequest/run.pid; sleep 30 & wait`], { cwd: root, detached: true, stdio: "ignore" });
    for (let i = 0; i < 50 && !(await runState(root)).running; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(await runState(root)).toEqual({ headless: true, running: true });

    expect(await stopRun(root, 1000)).toBe(true);
    for (let i = 0; i < 50 && pidExists(runner.pid!); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(pidExists(runner.pid!)).toBe(false);
    expect(await stopRun(root)).toBe(false);
  });

  it("opens a session interactively with its agent carrying on", () => {
    const config = configSchema.parse({ settings: { agent: { id: "claude", args: ["--model", "opus"] } } });
    expect(terminalCommand(config, "")).toEqual(["claude", "--continue", "--model", "opus"]);
    expect(terminalCommand(config, "codex")).toEqual(["codex", "resume", "--last"]);
  });
});
