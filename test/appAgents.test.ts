import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const FAKE_OPENER = "sidequest-fake-open";
const opened: string[] = [];
let openFails = false;

vi.mock("../src/util/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    run: vi.fn(async (command: string, args: string[], options?: Parameters<typeof actual.run>[2]) => {
      if (command !== FAKE_OPENER) return actual.run(command, args, options);
      if (openFails) throw new actual.CommandError(command, args, 1, "", "no app for that scheme");
      opened.push(args[args.length - 1]!);
      return { stdout: "", stderr: "" };
    }),
  };
});

vi.mock("../src/util/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/platform.js")>();
  return { ...actual, uriOpener: () => ({ command: FAKE_OPENER, args: [] }) };
});

const { AGENT_DEFINITIONS, agentDefinition, linkPrompt, MAX_LINK_PROMPT_CHARS, PROMPT_FILE_POINTER, resolveAgent } =
  await import("../src/agents/agents.js");
const { createSession } = await import("../src/session/create.js");
const { findSession, openSession } = await import("../src/session/reopen.js");
const { configSchema } = await import("../src/config/schema.js");

const exec = promisify(execFile);
let root: string;
let repoPath: string;

async function git(args: string[], cwd: string): Promise<void> {
  await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

beforeEach(async () => {
  opened.length = 0;
  openFails = false;
  root = await mkdtemp(join(tmpdir(), "sidequest-apps-"));
  repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await git(["init", "--initial-branch=main"], repoPath);
  await writeFile(join(repoPath, "README.md"), "# test\n");
  await git(["add", "."], repoPath);
  await git(["commit", "-m", "initial"], repoPath);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function configFor(agentId: string) {
  return configSchema.parse({
    settings: {
      worktreesRoot: join(root, "worktrees"),
      fetchBeforeCreate: false,
      agent: { id: agentId },
    },
    channels: { eng: [{ repoPath, channel: "eng" }] },
  });
}

const message = {
  channelName: "eng",
  authorName: "sam",
  text: "Checkout fails & the cart empties",
  ts: "1757420000.000100",
  permalink: "https://example.slack.com/archives/C1/p1757420000000100",
  threadMessages: [],
};

describe("desktop app agents", () => {
  it("ships Claude Desktop and ChatGPT as app agents", () => {
    expect(agentDefinition("claude-desktop").app).toBeDefined();
    expect(agentDefinition("chatgpt").app).toBeDefined();
    // The terminal agents stay terminal agents.
    expect(AGENT_DEFINITIONS.filter((d) => !d.app).map((d) => d.id)).toEqual(["claude", "codex"]);
  });

  it("builds Claude's Code-tab link with the prompt and the folder, encoded", () => {
    const uri = agentDefinition("claude-desktop").app!.newSessionUri("/tmp/wt a", "Fix it & test?");
    expect(uri).toBe("claude://code/new?q=Fix%20it%20%26%20test%3F&folder=%2Ftmp%2Fwt%20a");
  });

  it("builds ChatGPT's codex:// link with the prompt and the path", () => {
    const uri = agentDefinition("chatgpt").app!.newSessionUri("/tmp/wt", "hello");
    expect(uri).toBe("codex://threads/new?prompt=hello&path=%2Ftmp%2Fwt");
  });

  it("leaves the prompt out of a link that has none", () => {
    expect(agentDefinition("claude-desktop").app!.newSessionUri("/tmp/wt")).toBe("claude://code/new?folder=%2Ftmp%2Fwt");
    expect(agentDefinition("chatgpt").app!.newSessionUri("/tmp/wt")).toBe("codex://threads/new?path=%2Ftmp%2Fwt");
  });

  it("points a prompt too long for a link at the prompt file", () => {
    expect(linkPrompt("short")).toBe("short");
    expect(linkPrompt("x".repeat(MAX_LINK_PROMPT_CHARS + 1))).toBe(PROMPT_FILE_POINTER);
  });

  it("names where sessions open", () => {
    expect(resolveAgent({ id: "claude", command: "", args: [] }).host).toBe("Warp");
    expect(resolveAgent({ id: "claude-desktop", command: "", args: [] }).host).toBe("the Claude app");
    expect(resolveAgent({ id: "chatgpt", command: "", args: [] }).host).toBe("the ChatGPT app");
  });
});

describe("createSession with an app agent", () => {
  it("cuts the worktree and opens the Claude app in it with the prompt, no Warp and no pending marker", async () => {
    const result = await createSession("fix", message, configFor("claude-desktop"));

    expect(result.launchError).toBeUndefined();
    expect(result.launchStrategy).toBe("claude-desktop");
    expect(opened).toHaveLength(1);
    const uri = new URL(opened[0]!);
    expect(uri.protocol).toBe("claude:");
    expect(uri.searchParams.get("folder")).toBe(result.worktreePath);
    const prompt = await readFile(result.promptFile, "utf8");
    expect(uri.searchParams.get("q")).toBe(prompt.trimEnd());
    expect(prompt).toContain("Checkout fails & the cart empties");

    // A marker left behind would start a second agent in the first terminal opened there.
    await expect(stat(join(result.worktreePath, ".sidequest", "pending"))).rejects.toThrow();
  });

  it("opens the ChatGPT app on the worktree", async () => {
    const result = await createSession("investigate", message, configFor("chatgpt"));
    const uri = new URL(opened[0]!);
    expect(uri.protocol).toBe("codex:");
    expect(uri.searchParams.get("path")).toBe(result.worktreePath);
    expect(uri.searchParams.get("prompt")).toContain("Do NOT change any code yet");
  });

  it("keeps the worktree and reports the error when the app will not open", async () => {
    openFails = true;
    const result = await createSession("fix", message, configFor("claude-desktop"));
    expect(result.launchError).toMatch(/the Claude app/);
    await expect(stat(result.promptFile)).resolves.toBeTruthy();
  });

  it("reopens a session as a new one in the app, in the same worktree", async () => {
    const config = configFor("chatgpt");
    const result = await createSession("ask", message, config);
    opened.length = 0;

    const found = await findSession(config, result.branch);
    const reopened = await openSession(config, found!);
    expect(reopened).toMatchObject({ host: "the ChatGPT app", strategy: "chatgpt", agentStarted: null });
    expect(opened).toEqual([`codex://threads/new?path=${encodeURIComponent(result.worktreePath)}`]);
  });
});
