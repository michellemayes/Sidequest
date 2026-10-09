import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { followUpArgs, PROMPT_TOKEN, resolveAgent } from "../src/agents/agents.js";
import { armFollowUp, armContinue, autorunPaths, writeAutorun } from "../src/warp/autorun.js";
import { writeHeadlessRunner } from "../src/terminals/headless.js";
import { renderFollowUp } from "../src/session/followUp.js";

const exec = promisify(execFile);
let root: string;
let agent: string;
let calls: string;

/** An agent that writes each run's argv, one argument per line, then a blank line. */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-followup-session-"));
  calls = join(root, "calls");
  agent = join(root, "agent");
  await writeFile(agent, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${calls}"\necho >> "${calls}"\necho "the answer"\n`);
  await chmod(agent, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const runs = async () => (await readFile(calls, "utf8")).split("\n\n").filter(Boolean).map((r) => r.split("\n"));

describe("following up on a session", () => {
  it("carries the conversation on with the follow-up, for an agent that can take a prompt with --continue", async () => {
    const claude = { ...resolveAgent({ id: "claude", command: agent, args: [] }) };
    const files = await writeAutorun({
      worktreePath: root,
      prompt: "the task",
      agentCommand: agent,
      agentArgs: [],
      promptArgs: claude.promptArgs,
      continueArgs: claude.continueArgs,
      followUpArgs: followUpArgs(claude),
    });
    await exec(files.scriptFile, []);
    await armFollowUp(root, files.scriptFile, "now do it for Safari too");
    await exec(files.scriptFile, []);
    // Nothing armed: a third run is not a run at all.
    await exec(files.scriptFile, []);
    expect(await runs()).toEqual([["the task"], ["--continue", "now do it for Safari too"]]);
  });

  it("starts the agent afresh on the follow-up when its CLI cannot carry on with a new prompt", async () => {
    const goose = resolveAgent({ id: "goose", command: agent, args: [] });
    const files = await writeAutorun({
      worktreePath: root,
      prompt: "the task",
      agentCommand: agent,
      agentArgs: [],
      promptArgs: goose.promptArgs,
      followUpArgs: followUpArgs(goose),
    });
    await exec(files.scriptFile, []);
    await armFollowUp(root, files.scriptFile, "more");
    await exec(files.scriptFile, []);
    const [first, second] = await runs();
    expect(first!.at(-1)).toBe(join(root, ".sidequest", "prompt.md"));
    expect(second!.at(-1)).toBe(join(root, ".sidequest", "followup.md"));
  });

  it("wins over a reopen that has not been picked up yet", async () => {
    const files = await writeAutorun({
      worktreePath: root, prompt: "t", agentCommand: agent, agentArgs: [],
      continueArgs: ["--continue"], followUpArgs: ["--continue", PROMPT_TOKEN],
    });
    await exec(files.scriptFile, []);
    expect(await armContinue(root)).toBe(true);
    await armFollowUp(root, files.scriptFile, "this instead");
    await exec(files.scriptFile, []);
    expect((await runs())[1]).toEqual(["--continue", "this instead"]);
  });

  it("refuses a session that has not started, and one whose script predates follow-ups", async () => {
    const files = await writeAutorun({ worktreePath: root, prompt: "t", agentCommand: agent, agentArgs: [], followUpArgs: [PROMPT_TOKEN] });
    await expect(armFollowUp(root, files.scriptFile, "x")).rejects.toThrow(/not started yet/);
    const old = await writeAutorun({ worktreePath: root, prompt: "t", agentCommand: agent, agentArgs: [] });
    await rm(autorunPaths(root).pendingFile);
    await expect(armFollowUp(root, old.scriptFile, "x")).rejects.toThrow(/before Sidequest took follow-ups/);
  });

  it("runs a headless follow-up on followup.md, carrying on where the agent can, and answers again", async () => {
    // Claude Code streams JSON events; the answer is the last result event's text.
    await writeFile(agent, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${calls}"\necho >> "${calls}"\n` +
      `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'\n` +
      `echo '{"type":"result","subtype":"success","result":"the answer\\n"}'\n`);
    const claude = resolveAgent({ id: "claude", command: agent, args: [] });
    await writeAutorun({ worktreePath: root, prompt: "the task", agentCommand: agent, agentArgs: [] });
    const headless = await writeHeadlessRunner({
      worktreePath: root, agentCommand: agent, agentArgs: [], headless: claude.headless!, node: process.execPath,
    });
    await exec(headless.scriptFile, []);
    await armFollowUp(root, headless.scriptFile, "and the refund page");
    await exec(headless.scriptFile, []);
    const [first, second] = await runs();
    const stream = ["--output-format", "stream-json", "--verbose"];
    expect(first).toEqual(["-p", "--permission-mode", "acceptEdits", ...stream, "the task"]);
    expect(second).toEqual(["-p", "--permission-mode", "acceptEdits", "--continue", ...stream, "and the refund page"]);
    expect(await readFile(headless.resultFile, "utf8")).toBe("the answer\n");
    expect(await readFile(headless.logFile, "utf8")).toMatch(/finished .*, exit 0\n$/);

    // Both runs are in the event stream, each opened with its prompt and closed with how it ended.
    const events = (await readFile(headless.eventsFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const marks = events.filter((e) => e.type === "sidequest");
    expect(marks.map((m) => [m.event, m.mode ?? m.status])).toEqual([["run-start", "first"], ["run-end", 0], ["run-start", "followup"], ["run-end", 0]]);
    expect(marks[0].prompt).toBe("the task\n");
    expect(marks[2].prompt).toContain("and the refund page");
    // The pid is only there while a run is going.
    await expect(readFile(headless.pidFile, "utf8")).rejects.toThrow();
  });

  it("tells the agent what came in since and where the earlier work is", () => {
    const text = renderFollowUp(
      { text: "Check Safari", thread: [{ author: "dana", text: "still broken on Safari" }], channel: "eng" },
      "ask",
    );
    expect(text).toContain("# Follow-up from Slack (#eng)");
    expect(text).toContain("Check Safari");
    expect(text).toContain("@dana: still broken on Safari");
    expect(text).toContain(".sidequest/prompt.md");
    expect(text).toContain("## When you are done");
    expect(renderFollowUp({ text: "x", thread: [], channel: "" }, "off")).not.toContain("When you are done");
  });
});
