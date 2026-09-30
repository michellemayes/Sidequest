import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOutOfDate, depsFingerprint, depsOutOfDate } from "../src/update.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sidequest-update-"));
  await writeFile(join(root, "package.json"), '{"name":"x"}');
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stampDeps(value: string): Promise<void> {
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", ".sidequest-deps"), `${value}\n`);
}

describe("depsOutOfDate", () => {
  it("wants an install when node_modules was never installed by update", async () => {
    expect(await depsOutOfDate(root)).toBe(true);
  });

  it("skips the install while package.json and the lockfile are unchanged", async () => {
    await stampDeps(await depsFingerprint(root));
    expect(await depsOutOfDate(root)).toBe(false);
  });

  it("wants an install once the lockfile changes", async () => {
    await stampDeps(await depsFingerprint(root));
    await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    expect(await depsOutOfDate(root)).toBe(true);
  });
});

describe("buildOutOfDate", () => {
  it("is stale with no build, fresh for the commit it was built from, stale for any other", async () => {
    expect(await buildOutOfDate(root, "abc")).toBe(true);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", ".sidequest-build"), "abc\n");
    expect(await buildOutOfDate(root, "abc")).toBe(false);
    expect(await buildOutOfDate(root, "def")).toBe(true);
  });
});
