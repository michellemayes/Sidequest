import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const home = await mkdtemp(join(tmpdir(), "sidequest-daemon-"));
process.env.SIDEQUEST_HOME = home;

const daemon = await import("../src/daemon.js");
const { daemonLockFile, daemonPidFile } = await import("../src/config/paths.js");

/** A process that looks like a daemon from the outside: `<entry> start --foreground`. */
const ENTRY = "/opt/fake-sidequest/dist/index.js";
let fake: ChildProcess;

beforeAll(async () => {
  fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ENTRY, "start", "--foreground"], {
    stdio: "ignore",
  });
  // Give ps something to see.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(async () => {
  fake.kill("SIGKILL");
  await rm(home, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(daemonLockFile(), { force: true });
  await rm(daemonPidFile(), { force: true });
});

describe("daemon record", () => {
  it("writes the record whole, with the entry script", async () => {
    await daemon.writeDaemonRecord("abc");
    const rec = await daemon.readDaemonRecord();
    expect(rec).toMatchObject({ pid: process.pid, build: "abc", entry: process.argv[1] });
    // No temp file left behind.
    await expect(stat(`${daemonPidFile()}.${process.pid}.tmp`)).rejects.toThrow();
  });
});

describe("isSidequestProcess", () => {
  it("recognises a daemon by its script and `start`", async () => {
    const at = new Date(Date.now() + 1000).toISOString();
    expect(await daemon.daemonAlive({ pid: fake.pid!, startedAt: at, entry: ENTRY })).toBe(true);
  });

  it("refuses a pid that runs something else", async () => {
    const at = new Date().toISOString();
    expect(await daemon.daemonAlive({ pid: fake.pid!, startedAt: at, entry: "/elsewhere/index.js" })).toBe(false);
    // This test process is alive but is not a daemon.
    expect(await daemon.daemonAlive({ pid: process.pid, startedAt: at, entry: process.argv[1] })).toBe(false);
  });

  it("refuses a process that started after the record was written", async () => {
    const long = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(await daemon.daemonAlive({ pid: fake.pid!, startedAt: long, entry: ENTRY })).toBe(false);
  });

  it("refuses a pid nobody has", async () => {
    expect(await daemon.daemonAlive({ pid: 2 ** 22 + 12345, startedAt: "" })).toBe(false);
  });
});

describe("lockDaemon", () => {
  it("takes a free lock and refuses a second taker while a daemon holds it", async () => {
    expect(await daemon.lockDaemon()).toBeNull();
    // Now pretend a live daemon holds it.
    await writeFile(daemonLockFile(), JSON.stringify({ pid: fake.pid, at: Date.now(), entry: ENTRY }));
    const holder = await daemon.lockDaemon();
    expect(holder?.pid).toBe(fake.pid);
  });

  it("takes over a lock whose holder is gone or is not a daemon", async () => {
    await writeFile(daemonLockFile(), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await daemon.lockDaemon()).toBeNull();
    expect(JSON.parse(await readFile(daemonLockFile(), "utf8")).pid).toBe(process.pid);

    await writeFile(daemonLockFile(), JSON.stringify({ pid: fake.pid, at: Date.now(), entry: "/not/it.js" }));
    expect(await daemon.lockDaemon()).toBeNull();
  });

  it("releases only its own lock", async () => {
    await writeFile(daemonLockFile(), JSON.stringify({ pid: fake.pid, at: Date.now(), entry: ENTRY }));
    await daemon.unlockDaemon();
    await expect(stat(daemonLockFile())).resolves.toBeTruthy();
  });
});

describe("log", () => {
  it("rotates past the limit, keeping one old log", async () => {
    const file = join(home, "test.log");
    await writeFile(file, "x".repeat(100));
    expect(await daemon.rotateLog(file, 1000)).toBe(false);
    await writeFile(file, "y".repeat(2000));
    expect(await daemon.rotateLog(file, 1000)).toBe(true);
    expect((await readFile(`${file}.1`, "utf8")).length).toBe(2000);
    await expect(stat(file)).rejects.toThrow();
  });

  it("reads only the tail, from a whole line", async () => {
    const file = join(home, "tail.log");
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    await writeFile(file, `${lines.join("\n")}\n`);
    const tail = await daemon.readTail(file, 100);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail.split("\n")[0]).toMatch(/^line \d+$/);
    expect(tail.trimEnd().endsWith("line 999")).toBe(true);
    expect(await daemon.readTail(join(home, "missing.log"))).toBe("");
  });
});
