import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DEFINITIONS,
  agentArgv,
  agentConfigFor,
  agentDefinition,
  describeAgent,
  describeHeadless,
  followUpArgs,
  fillPromptArg,
  resolveAgent,
} from "../src/agents/agents.js";
import { loadConfig, promptFor } from "../src/config/store.js";
import { configSchema } from "../src/config/schema.js";
import { pageConfig } from "../src/config/pageConfig.js";

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
    expect(ids).toEqual([
      "claude",
      "codex",
      "gemini",
      "aider",
      "cursor-agent",
      "opencode",
      "copilot",
      "qwen",
      "goose",
      "claude-desktop",
      "chatgpt",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of AGENT_DEFINITIONS.filter((d) => !d.app)) {
      expect(def.host).toBe("Warp");
      expect(def.installHint).toContain("settings.agent.command");
    }
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
    expect(describeAgent(aider)).toBe(
      "aider --model sonnet --message-file .sidequest/prompt.md, then aider --model sonnet --restore-chat-history",
    );
  });

  it("only aider needs a second run", () => {
    const resumed = AGENT_DEFINITIONS.filter((d) => resolveAgent({ id: d.id, command: "", args: [] }).resumeArgs);
    expect(resumed.map((d) => d.id)).toEqual(["aider"]);
  });

  it("every terminal agent can carry on its last conversation", () => {
    const terminalAgents = AGENT_DEFINITIONS.filter((d) => !d.app);
    for (const d of terminalAgents) {
      expect(resolveAgent({ id: d.id, command: "", args: [] }).continueArgs, d.id).toBeTruthy();
    }
    expect(resolveAgent({ id: "claude", command: "", args: [] }).continueArgs).toEqual(["--continue"]);
    expect(resolveAgent({ id: "codex", command: "", args: [] }).continueArgs).toEqual(["resume", "--last"]);
  });

  it("describes a plain agent by its first run", () => {
    expect(describeAgent(resolveAgent({ id: "opencode", command: "", args: [] }))).toBe(
      "opencode --prompt <prompt>",
    );
  });

  it("describes an app agent by the link it opens", () => {
    expect(describeAgent(resolveAgent({ id: "claude-desktop", command: "", args: [] }))).toBe(
      "opens claude://code/new in the Claude app",
    );
    expect(describeAgent(resolveAgent({ id: "chatgpt", command: "", args: [] }))).toBe(
      "opens codex://threads/new in the ChatGPT app",
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

describe("an agent per prompt", () => {
  const settingsAgent = { id: "claude", command: "/opt/claude", args: ["--model", "opus"] };

  it("keeps settings.agent, command and args, when a prompt names none or the same one", () => {
    expect(agentConfigFor(settingsAgent, "")).toBe(settingsAgent);
    expect(agentConfigFor(settingsAgent, "claude")).toBe(settingsAgent);
  });

  it("runs another agent with its own defaults, not settings.agent's command and args", () => {
    expect(agentConfigFor(settingsAgent, "codex")).toEqual({ id: "codex", command: "", args: [] });
    expect(resolveAgent(agentConfigFor(settingsAgent, "codex")).command).toBe("codex");
  });

  it("takes the agent from a prompt's override and names it in the page's menu", () => {
    const config = configSchema.parse({ prompts: { review: { agent: "codex" } } });
    expect(promptFor(config, "review")?.agent).toBe("codex");
    expect(promptFor(config, "fix")?.agent).toBe("");
    const prompts = pageConfig(config).prompts;
    expect(prompts.find((p) => p.key === "review")?.agentLabel).toBe("Codex");
    expect(prompts.find((p) => p.key === "fix")).not.toHaveProperty("agentLabel");
  });

  it("refuses an agent it does not know, rather than quietly running Claude Code", () => {
    const parsed = configSchema.safeParse({ prompts: { fix: { agent: "clippy" } } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("clippy");
  });
});

describe("skipping permission prompts", () => {
  const skip = { skipPermissions: true };

  it("adds each agent's own flag after the user's args", () => {
    expect(resolveAgent({ id: "claude", command: "", args: ["--model", "opus"] }, skip).args).toEqual([
      "--model",
      "opus",
      "--dangerously-skip-permissions",
    ]);
    expect(resolveAgent({ id: "codex", command: "", args: [] }, skip).args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(resolveAgent({ id: "gemini", command: "", args: [] }, skip).args).toEqual(["--yolo"]);
  });

  it("carries the flag into follow-ups", () => {
    const agent = resolveAgent({ id: "claude", command: "", args: [] }, skip);
    expect(followUpArgs(agent)).toEqual(["--continue", "--dangerously-skip-permissions", "{prompt}"]);
  });

  it("leaves things alone when off, or when the user's args already ask for it", () => {
    expect(resolveAgent({ id: "claude", command: "", args: [] }).args).toEqual([]);
    expect(resolveAgent({ id: "claude", command: "", args: [] }).skipsPermissions).toBeUndefined();
    const already = resolveAgent({ id: "claude", command: "", args: ["--dangerously-skip-permissions"] }, skip);
    expect(already.args).toEqual(["--dangerously-skip-permissions"]);
  });

  it("drops the headless limits for the agent's own flag", () => {
    expect(describeHeadless(resolveAgent({ id: "claude", command: "", args: [] }, skip))).toBe(
      "claude -p --dangerously-skip-permissions <prompt>",
    );
    expect(describeHeadless(resolveAgent({ id: "codex", command: "", args: [] }, skip))).toBe(
      "codex exec --output-last-message .sidequest/result.md --dangerously-bypass-approvals-and-sandbox <prompt>",
    );
    expect(describeHeadless(resolveAgent({ id: "claude", command: "", args: [] }))).toBe(
      "claude -p --permission-mode acceptEdits <prompt>",
    );
  });

  it("ignores agents with no such flag", () => {
    const goose = resolveAgent({ id: "goose", command: "", args: [] }, skip);
    expect(goose.args).toEqual([]);
    expect(goose.skipsPermissions).toBeUndefined();
    expect(resolveAgent({ id: "claude-desktop", command: "", args: [] }, skip).skipsPermissions).toBeUndefined();
  });

  it("applies to a prompt's own agent and tells the overlay", () => {
    const config = configSchema.parse({
      settings: { skipPermissions: true },
      prompts: { review: { agent: "codex" } },
    });
    const review = resolveAgent(agentConfigFor(config.settings.agent, "codex"), config.settings);
    expect(review.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(pageConfig(config).skipPermissions).toBe(true);
    expect(pageConfig(configSchema.parse({})).skipPermissions).toBe(false);
  });
});
