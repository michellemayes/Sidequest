import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, buildOutOfDate, depsFingerprint, depsOutOfDate } from "../src/update.js";

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

describe("build", () => {
  it("leaves dist/index.js executable so the linked `sidequest` command still runs", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "#!/usr/bin/env node\nconsole.log(1);\n");
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", target: "es2022", rootDir: "src" }, include: ["src"] }),
    );
    await mkdir(join(root, "node_modules"));
    await symlink(resolve("node_modules", "typescript"), join(root, "node_modules", "typescript"));

    await build(root, "abc");

    expect((await stat(join(root, "dist", "index.js"))).mode & 0o111).toBe(0o111);
    expect(await buildOutOfDate(root, "abc")).toBe(false);
  }, 60_000);
});
