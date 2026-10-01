import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const home = await mkdtemp(join(tmpdir(), "sidequest-config-lock-"));
process.env.SIDEQUEST_HOME = home;

const { loadConfig, updateConfig } = await import("../src/config/store.js");
const { configFile } = await import("../src/config/paths.js");

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("updateConfig", () => {
  it("keeps every change when updates overlap", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateConfig(async (config) => {
          // Long enough that unlocked updates would read the same version.
          await new Promise((resolve) => setTimeout(resolve, 5));
          config.settings.repoSearchRoots.push(`/r${i}`);
        }),
      ),
    );
    expect((await loadConfig()).settings.repoSearchRoots).toHaveLength(12);
    // Neither the lock nor a temp file is left behind.
    expect((await readdir(home)).sort()).toEqual(["config.json"]);
  });

  it("takes over a lock left by a process that died", async () => {
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => dead.on("exit", resolve));
    await writeFile(`${configFile()}.lock`, JSON.stringify({ pid: dead.pid, at: Date.now() }));
    await updateConfig((config) => {
      config.settings.verbose = true;
    });
    expect((await loadConfig()).settings.verbose).toBe(true);
  });

  it("waits for a live holder and gives up with a clear error", async () => {
    // This process holds it under another name: alive, and not us.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      await writeFile(`${configFile()}.lock`, JSON.stringify({ pid: sleeper.pid, at: Date.now() }));
      const started = Date.now();
      await expect(updateConfig(() => undefined)).rejects.toThrow(/still writing/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    } finally {
      sleeper.kill("SIGKILL");
      await rm(`${configFile()}.lock`, { force: true });
    }
  }, 15_000);
});
