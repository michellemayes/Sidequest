/**
 * `sidequest update`: bring a git checkout of Sidequest up to date in one step.
 *
 * Updating by hand meant `git pull && npm install && npm run build`, where a
 * failed build left `dist/` half-written and the daemon still running old
 * code. This does the same work with less to go wrong:
 *
 *   - dependencies are installed (with `npm ci`, from the lockfile) only when
 *     package.json or package-lock.json changed since the last install,
 *   - the build goes to a scratch directory and replaces `dist/` only once it
 *     succeeds, so a broken build never takes down a working install,
 *   - a failed install or build puts the checkout back on the commit it was on,
 *   - and a running daemon is restarted on the new code, including one left
 *     on an older build by an earlier `--no-restart` or a manual rebuild.
 */
import { createHash } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, CommandError } from "./util/exec.js";
import { UserFacingError } from "./util/errors.js";
import { exists } from "./util/fs.js";

/** The checkout this code runs from: the parent of `dist/` (or `src/` under tsx). */
export function installRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
}

/**
 * Present in the copy of Sidequest the Mac app carries inside its bundle,
 * which the app's own updates replace; `sidequest update` leaves it alone.
 */
export const BUNDLED_MARKER = ".sidequest-bundled";

export async function isBundled(root = installRoot()): Promise<boolean> {
  return exists(join(root, BUNDLED_MARKER));
}

/** Written after a successful `npm ci`; holds the dependency fingerprint it installed. */
const INSTALL_STAMP = join("node_modules", ".sidequest-deps");
/** Written into each build; holds the commit it was built from. */
const BUILD_STAMP = ".sidequest-build";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;

/** A hash of everything that decides what `npm ci` installs. */
export async function depsFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) {
    hash.update(file);
    hash.update(await readFile(join(root, file)).catch(() => Buffer.alloc(0)));
  }
  return hash.digest("hex");
}

/** True when node_modules is missing or was installed for other dependencies. */
export async function depsOutOfDate(root: string): Promise<boolean> {
  const installed = await readFile(join(root, INSTALL_STAMP), "utf8").catch(() => null);
  return installed?.trim() !== (await depsFingerprint(root));
}

/** The commit dist/ was built from, or null when it has no stamp (or no dist/). */
export async function builtCommit(root: string): Promise<string | null> {
  const built = await readFile(join(root, "dist", BUILD_STAMP), "utf8").catch(() => null);
  return built?.trim() || null;
}

/** True when dist/ is missing or was built from a different commit. */
export async function buildOutOfDate(root: string, commit: string): Promise<boolean> {
  return (await builtCommit(root)) !== commit;
}

/**
 * True when a daemon that recorded `daemonBuild` at startup is running older
 * code than dist/ now holds. A daemon from before builds were recorded has no
 * `daemonBuild` at all, and is stale by definition.
 */
export async function daemonOutOfDate(root: string, daemonBuild: string | undefined): Promise<boolean> {
  if (daemonBuild === undefined) return true;
  return daemonBuild !== ((await builtCommit(root)) ?? "");
}

export async function installDeps(root: string): Promise<void> {
  await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  await writeFile(join(root, INSTALL_STAMP), `${await depsFingerprint(root)}\n`);
}

/** Compile into dist.next, then swap it in, so dist/ is never half-built. */
export async function build(root: string, commit: string): Promise<void> {
  const next = join(root, "dist.next");
  const old = join(root, "dist.old");
  const dist = join(root, "dist");
  await rm(next, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  try {
    await run(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", next], {
      cwd: root,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } catch (err) {
    await rm(next, { recursive: true, force: true });
    throw err;
  }
  // tsc writes files without the execute bit, and `npm link` only set it on
  // the dist/index.js it linked, so the fresh one needs it back or the
  // `sidequest` command fails with "permission denied".
  await chmod(join(next, "index.js"), 0o755);
  await writeFile(join(next, BUILD_STAMP), `${commit}\n`);
  if (await exists(dist)) await rename(dist, old);
  await rename(next, dist);
  await rm(old, { recursive: true, force: true });
}

export interface UpdatePlan {
  root: string;
  branch: string;
  upstream: string;
  from: string;
  to: string;
}

/** Check the checkout can be fast-forwarded, fetch, and say where it would go. */
export async function planUpdate(root: string): Promise<UpdatePlan> {
  if (!(await exists(join(root, ".git")))) {
    throw new UserFacingError(
      `${root} is not a git checkout, so \`sidequest update\` can't pull into it.`,
      "Reinstall from a clone: https://github.com/michellemayes/Sidequest#quick-start",
    );
  }
  const git = (args: string[]) => run("git", args, { cwd: root }).then((r) => r.stdout.trim());

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "");
  if (!upstream) {
    throw new UserFacingError(
      `The Sidequest checkout is on ${branch === "HEAD" ? "a detached HEAD" : `\`${branch}\``}, which tracks no remote branch.`,
      `Run \`git -C ${root} checkout main\`, then \`sidequest update\` again.`,
    );
  }
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new UserFacingError(
      "The Sidequest checkout has local changes, so updating could clobber them.",
      `Commit or stash them in ${root} (\`git -C ${root} stash\`), then run \`sidequest update\` again.`,
    );
  }

  // With no arguments, fetch goes to the branch's own remote.
  await run("git", ["fetch", "--quiet"], { cwd: root, timeoutMs: 120_000 });
  const from = await git(["rev-parse", "HEAD"]);
  const to = await git(["rev-parse", "@{u}"]);
  if (from !== to && !(await isAncestor(root, from, to))) {
    throw new UserFacingError(
      `The Sidequest checkout has commits that aren't on ${upstream}, so it can't fast-forward.`,
      `Sort it out in ${root} (e.g. \`git -C ${root} reset --hard ${upstream}\` to drop them).`,
    );
  }
  return { root, branch, upstream, from, to };
}

async function isAncestor(root: string, ancestor: string, of: string): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, of], { cwd: root });
    return true;
  } catch (err) {
    if (err instanceof CommandError && err.code === 1) return false;
    throw err;
  }
}

/** One-line summaries of the commits between two revisions, oldest first. */
export async function changelog(root: string, from: string, to: string): Promise<string[]> {
  if (from === to) return [];
  const { stdout } = await run("git", ["log", "--reverse", "--format=%s", `${from}..${to}`], { cwd: root });
  return stdout.split("\n").filter((line) => line.trim() && !line.startsWith("Merge "));
}

export async function fastForward(root: string, to: string): Promise<void> {
  await run("git", ["merge", "--ff-only", "--quiet", to], { cwd: root });
}

/** Put the checkout back where it was; `--keep` refuses rather than lose local edits. */
export async function rollBack(root: string, to: string): Promise<void> {
  await run("git", ["reset", "--keep", "--quiet", to], { cwd: root });
}
