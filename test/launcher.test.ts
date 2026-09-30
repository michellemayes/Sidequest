import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opened: string[] = [];
let onOpen: (uri: string) => Promise<void> = async () => {};

vi.mock("../src/util/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/exec.js")>();
  return {
    ...actual,
    run: vi.fn(async (_command: string, args: string[]) => {
      const uri = args[args.length - 1]!;
      opened.push(uri);
      await onOpen(uri);
      return { stdout: "", stderr: "" };
    }),
  };
});

vi.mock("../src/util/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/platform.js")>();
  return {
    ...actual,
    uriOpener: () => ({ command: "open", args: [] }),
    warpLaunchConfigDir: () => join(root, "launch"),
    warpTabConfigDir: () => join(root, "tabs"),
  };
});

const { launchWarp, strategyOrder } = await import("../src/warp/launcher.js");

let root: string;
let pendingFile: string;

const spec = () => ({
  name: "sidequest-test",
  title: "Test",
  color: "blue" as const,
  cwd: root,
  command: "true",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-launcher-"));
  pendingFile = join(root, "pending");
  await writeFile(pendingFile, "");
  opened.length = 0;
  onOpen = async () => {};
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("launchWarp", () => {
  it("stops at the first strategy whose tab claims the session", async () => {
    onOpen = async () => rm(pendingFile);
    const result = await launchWarp({ spec: spec(), strategy: "launch_config", preview: false, pendingFile, tabConfigSettleMs: 0, claimTimeoutMs: 300 });
    expect(result).toMatchObject({ strategy: "launch_config", fellBack: false, agentStarted: true });
    expect(opened).toHaveLength(1);
  });

  it("falls through when Warp opens but nothing runs the agent", async () => {
    // Warp ignores the launch config; only the new tab's shell hook fires.
    onOpen = async (uri) => {
      if (uri.includes("action/new_tab")) await rm(pendingFile);
    };
    const result = await launchWarp({ spec: spec(), strategy: "launch_config", preview: false, pendingFile, tabConfigSettleMs: 0, claimTimeoutMs: 300 });
    expect(result).toMatchObject({ strategy: "new_tab", fellBack: true, agentStarted: true });
    expect(opened.map((u) => u.split("://")[1]!.split("/")[0])).toEqual(["launch", "tab_config", "action"]);
  });

  it("reports that the agent never started", async () => {
    const result = await launchWarp({ spec: spec(), strategy: "launch_config", preview: false, pendingFile, tabConfigSettleMs: 0, claimTimeoutMs: 200 });
    expect(result).toMatchObject({ strategy: "new_tab", agentStarted: false });
  });

  it("does not wait when there is no pending session", async () => {
    await rm(pendingFile);
    const result = await launchWarp({ spec: spec(), strategy: "launch_config", preview: false, pendingFile, tabConfigSettleMs: 0 });
    expect(result).toMatchObject({ strategy: "launch_config", agentStarted: null });
    expect(opened).toHaveLength(1);
  });

  it("auto tries a tab config first, since Warp picks those up while running", async () => {
    onOpen = async (uri) => {
      if (uri.includes("tab_config")) await rm(pendingFile);
    };
    const result = await launchWarp({ spec: spec(), strategy: "auto", preview: false, pendingFile, claimTimeoutMs: 300, tabConfigSettleMs: 0 });
    expect(result).toMatchObject({ strategy: "tab_config", fellBack: false, agentStarted: true });
    expect(opened).toHaveLength(1);
  });

  it("gives Warp's file watcher a moment before opening a new tab config", async () => {
    await rm(pendingFile);
    const started = Date.now();
    await launchWarp({ spec: spec(), strategy: "tab_config", preview: false, pendingFile, tabConfigSettleMs: 150 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("does not wait again for a tab config written ahead of time", async () => {
    await rm(pendingFile);
    const preparedTabConfig = { uri: "warp://tab_config/sidequest-test", writtenAt: Date.now() - 1_000 };
    const started = Date.now();
    const result = await launchWarp({ spec: spec(), strategy: "tab_config", preview: false, pendingFile, tabConfigSettleMs: 500, preparedTabConfig });
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.uri).toBe(preparedTabConfig.uri);
    expect(opened).toEqual([preparedTabConfig.uri]);
  });
});

describe("strategyOrder", () => {
  it("puts the preferred strategy first and never falls back from new_tab", () => {
    expect(strategyOrder("auto")).toEqual(["tab_config", "launch_config", "new_tab"]);
    expect(strategyOrder("launch_config")).toEqual(["launch_config", "tab_config", "new_tab"]);
    expect(strategyOrder("new_tab")).toEqual(["new_tab"]);
  });
});
