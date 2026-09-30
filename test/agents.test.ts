import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DEFINITIONS,
  agentArgv,
  agentDefinition,
  describeInvocation,
  fillPromptArg,
  resolveAgent,
} from "../src/agents/agents.js";
import { loadConfig } from "../src/config/store.js";

let home: string;
const OLD_HOME = process.env.SIDEQUEST_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sidequest-agents-"));
  process.env.SIDEQUEST_HOME = home;
});

afterEach(async () => {
  if (OLD_HOME === undefined) delete process.env.SIDEQUEST_HOME;
  else process.env.SIDEQUEST_HOME = OLD_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("agent registry", () => {
  it("resolves claude by default", () => {
    const agent = resolveAgent({ id: "claude", command: "", args: [] });
    expect(agent.id).toBe("claude");
    expect(agent.label).toBe("Claude Code");
    expect(agent.command).toBe("claude");
    expect(agent.args).toEqual([]);
  });

  it("resolves codex", () => {
    const agent = resolveAgent({ id: "codex", command: "", args: [] });
    expect(agent.id).toBe("codex");
    expect(agent.label).toBe("Codex");
    expect(agent.command).toBe("codex");
  });

  it("prefers command and args overrides over the built-in defaults", () => {
    const agent = resolveAgent({
      id: "codex",
      command: "/usr/local/bin/codex",
      args: ["--model", "o3"],
    });
    expect(agent.command).toBe("/usr/local/bin/codex");
    expect(agent.args).toEqual(["--model", "o3"]);
    // The label still comes from the registry.
    expect(agent.label).toBe("Codex");
  });

  it("falls back to the first agent for unknown ids", () => {
    expect(agentDefinition("definitely-not-an-agent").id).toBe("claude");
  });

  it("ships every supported agent, with unique ids", () => {
    const ids = AGENT_DEFINITIONS.map((d) => d.id);
    expect(ids).toEqual(["claude", "codex", "gemini", "aider", "cursor-agent", "opencode", "copilot", "qwen", "goose"]);
    expect(new Set(AGENT_DEFINITIONS.map((d) => d.label)).size).toBe(ids.length);
    for (const def of AGENT_DEFINITIONS) expect(def.installHint).toContain("settings.agent.command");
  });
});

describe("agent invocations", () => {
  const argv = (id: string, args: string[] = []) =>
    agentArgv(resolveAgent({ id, command: "", args }), "Fix it.", "/wt/.sidequest/prompt.md");

  // Each one starts an interactive session whose first turn is the prompt.
  it.each([
    ["claude", ["claude", "Fix it."]],
    ["codex", ["codex", "Fix it."]],
    ["gemini", ["gemini", "--prompt-interactive", "Fix it."]],
    ["aider", ["aider", "--message-file", "/wt/.sidequest/prompt.md"]],
    ["cursor-agent", ["cursor-agent", "Fix it."]],
    ["opencode", ["opencode", "--prompt", "Fix it."]],
    ["copilot", ["copilot", "--interactive", "Fix it."]],
    ["qwen", ["qwen", "--prompt-interactive", "Fix it."]],
    ["goose", ["goose", "run", "--interactive", "--instructions", "/wt/.sidequest/prompt.md"]],
  ])("launches %s", (id, expected) => {
    expect(argv(id)).toEqual(expected);
  });

  it("puts user args before the prompt flag", () => {
    expect(argv("gemini", ["--model", "gemini-2.5-pro"])).toEqual([
      "gemini",
      "--model",
      "gemini-2.5-pro",
      "--prompt-interactive",
      "Fix it.",
    ]);
  });

  it("resumes aider's chat after its one-shot first message", () => {
    const aider = resolveAgent({ id: "aider", command: "", args: ["--model", "sonnet"] });
    expect(aider.resumeArgs).toEqual(["--restore-chat-history"]);
    expect(describeInvocation(aider)).toBe(
      "aider --model sonnet --message-file .sidequest/prompt.md, then aider --model sonnet --restore-chat-history",
    );
  });

  it("only aider needs a second run", () => {
    const resumed = AGENT_DEFINITIONS.filter((d) => resolveAgent({ id: d.id, command: "", args: [] }).resumeArgs);
    expect(resumed.map((d) => d.id)).toEqual(["aider"]);
  });

  it("describes a plain agent by its first run", () => {
    expect(describeInvocation(resolveAgent({ id: "opencode", command: "", args: [] }))).toBe(
      "opencode --prompt <prompt>",
    );
  });

  it("fills placeholders inside an arg", () => {
    expect(fillPromptArg("--file={promptFile}", "p", "/f")).toBe("--file=/f");
    expect(fillPromptArg("{prompt}", "has {promptFile} in it", "/f")).toBe("has {promptFile} in it");
  });
});

describe("agent config migration", () => {
  it("migrates claudeCommand/claudeArgs to settings.agent", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        settings: { claudeCommand: "/opt/claude", claudeArgs: ["--model", "opus"] },
      }),
    );
    const config = await loadConfig();
    expect(config.settings.agent).toMatchObject({
      id: "claude",
      command: "/opt/claude",
      args: ["--model", "opus"],
    });
    expect(resolveAgent(config.settings.agent).command).toBe("/opt/claude");
  });

  it("leaves an explicit agent alone", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ settings: { agent: { id: "codex" } } }),
    );
    const config = await loadConfig();
    expect(resolveAgent(config.settings.agent).id).toBe("codex");
  });

  it("defaults to the claude agent on a fresh config", async () => {
    const config = await loadConfig();
    expect(resolveAgent(config.settings.agent).id).toBe("claude");
  });
});

describe("warp strategy migration", () => {
  it("moves the old launch_config default to auto", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ settings: { warpStrategy: "launch_config" } }),
    );
    expect((await loadConfig()).settings.warpStrategy).toBe("auto");
  });

  it("keeps any other strategy", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ settings: { warpStrategy: "new_tab" } }),
    );
    expect((await loadConfig()).settings.warpStrategy).toBe("new_tab");
  });
});
