import { spawn } from "node:child_process";
import { join } from "node:path";
import { daemonAlive, readDaemonRecord } from "../daemon.js";
import {
  build,
  buildOutOfDate,
  changelog,
  daemonOutOfDate,
  depsOutOfDate,
  fastForward,
  installDeps,
  installRoot,
  isBundled,
  planUpdate,
  rollBack,
} from "../update.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { stop } from "./daemon.js";
import { plural } from "./shared.js";

/**
 * Pull, install only if the lockfile moved, build beside dist/ and swap it in,
 * then restart the daemon on the new code. Any failure after the pull puts the
 * checkout back on the commit it was on.
 */
export async function update(options: { restart: boolean }): Promise<void> {
  const root = installRoot();
  if (await isBundled(root)) {
    throw new UserFacingError(
      "This Sidequest came with the Mac app, which keeps it up to date.",
      "Use Sidequest › Check for Updates… in the app.",
    );
  }
  console.log(`Checking for updates (${root})…`);
  const plan = await planUpdate(root);
  const commits = await changelog(root, plan.from, plan.to);
  const needDeps = await depsOutOfDate(root);
  const needBuild = await buildOutOfDate(root, plan.to);
  if (commits.length === 0 && plan.from === plan.to && !needDeps && !needBuild) {
    // Nothing to pull or build, but the daemon may still be on older code
    // (an earlier `--no-restart`, or a rebuild it never picked up).
    const rec = await readDaemonRecord();
    if (!rec || !(await daemonAlive(rec)) || !(await daemonOutOfDate(root, rec.build))) {
      console.log("Sidequest is already up to date.");
      return;
    }
    if (!options.restart) {
      console.log(
        "Sidequest is already up to date, but the daemon is on an older version until you run `sidequest stop && sidequest start`.",
      );
      return;
    }
    console.log("Sidequest is already up to date, but the daemon is running an older version.");
    await restartDaemon(root);
    return;
  }

  if (plan.from !== plan.to) {
    await fastForward(root, plan.to);
    console.log(`Pulled ${plural(commits.length, "change")} from ${plan.upstream}:`);
    for (const line of commits.slice(-15)) console.log(`  • ${line}`);
    if (commits.length > 15) console.log(`  … and ${commits.length - 15} earlier`);
  }

  let depsTouched = false;
  try {
    if (await depsOutOfDate(root)) {
      console.log("Installing dependencies (they changed)…");
      depsTouched = true;
      await installDeps(root);
    } else {
      console.log("Dependencies unchanged; skipping npm install.");
    }
    console.log("Building…");
    await build(root, plan.to);
  } catch (err) {
    if (plan.from !== plan.to) await rollBack(root, plan.from);
    if (depsTouched) await installDeps(root).catch(() => undefined);
    const { message } = describeError(err);
    throw new UserFacingError(
      `Update failed, so Sidequest stayed on the version it was on.\n${message}`,
      "Run `sidequest update` again; if it keeps failing, please open an issue with the error above.",
    );
  }

  const rec = await readDaemonRecord();
  if (!rec || !(await daemonAlive(rec))) {
    console.log("\nUpdated. Run `sidequest start` when you want the overlay.");
    return;
  }
  if (!options.restart) {
    console.log("\nUpdated. The daemon is still on the old version until you run `sidequest stop && sidequest start`.");
    return;
  }
  await restartDaemon(root);
}

async function restartDaemon(root: string): Promise<void> {
  console.log("\nRestarting the daemon on the new version…");
  await stop();
  // A fresh process, so the restart runs the code that was just built.
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist", "index.js"), "start"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new UserFacingError("Updated, but the daemon didn't come back up.", "Run `sidequest start` to see why.");
  }
}
