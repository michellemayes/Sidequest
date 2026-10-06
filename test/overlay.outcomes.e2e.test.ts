import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import { loadHistory, updateSession } from "../src/session/history.js";
import {
  describeIfChrome,
  exec,
  apiHandlers,
  attachAndEval,
  configHome,
  evaluate,
  formField,
  hover,
  madeSession,
  press,
  settledResult,
  UI,
  useOverlayBrowser,
} from "./support/overlay.js";

/** Every reactions.add and reactions.remove the page made, as "add:eyes". */
function recordReactions(): string[] {
  const seen: string[] = [];
  for (const method of ["reactions.add", "reactions.remove"]) {
    apiHandlers.set(method, (body) => {
      seen.push(`${method.split(".")[1]}:${formField(body, "name")}@${formField(body, "channel")}/${formField(body, "timestamp")}`);
      return { ok: true };
    });
  }
  return seen;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const file = join(configHome, "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  Object.assign(config.settings, patch);
  await writeFile(file, JSON.stringify(config));
}

const SIGN_IN = `localStorage.setItem('localConfig_v2', JSON.stringify({
  teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
}))`;

describeIfChrome("overlay over CDP: how a session is going, on its message", () => {
  useOverlayBrowser(6);

  it("puts 👀 on the message when a session starts, with settings.reactions on", async () => {
    await setSettings({ reactions: true });
    const seen = recordReactions();
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, SIGN_IN);
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "1", "Digit1", 49);
      expect(await settledResult(session)).toContain("investigate/");
      const deadline = Date.now() + 5000;
      while (seen.length === 0 && Date.now() < deadline) await sleep(100);
      expect(seen).toEqual(["add:eyes@C0SMOKE/1757430000.000100"]);

      // How it ended comes from the daemon, which asks one window to say so.
      const took = await evaluate(
        session,
        `window.__sidequestReact(JSON.stringify({ permalink: ${JSON.stringify(
          "http://127.0.0.1/archives/C0SMOKE/p1757430000000100",
        )}, name: 'white_check_mark' }))`,
      );
      expect(took).toBe(true);
      while (seen.length < 3 && Date.now() < deadline + 5000) await sleep(100);
      expect(seen.slice(1)).toEqual([
        "remove:eyes@C0SMOKE/1757430000.000100",
        "add:white_check_mark@C0SMOKE/1757430000.000100",
      ]);
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("reacts to nothing with settings.reactions off, as it is by default", async () => {
    const seen = recordReactions();
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, SIGN_IN);
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "1", "Digit1", 49);
      expect(await settledResult(session)).toContain("investigate/");
      await sleep(800);
      expect(seen).toEqual([]);
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("swaps 👀 for ❌ once a headless run fails, and only once", async () => {
    await setSettings({ reactions: true });
    const seen = recordReactions();
    const worktree = await madeSession("fix/broken", 1);
    await updateSession("fix/broken", {
      ts: "1757430000.000100",
      permalink: "http://127.0.0.1/archives/C0SMOKE/p1757430000000100",
    });
    await mkdir(join(worktree, ".sidequest"), { recursive: true });
    await writeFile(
      join(worktree, ".sidequest", "agent.log"),
      "sidequest: started 2026-10-06T00:00:00Z\nsidequest: finished 2026-10-06T00:00:09Z, exit 1\n",
    );

    // Signed in from the start, as a real Slack window is.
    const first = await attachAndEval();
    await evaluate(first.session, SIGN_IN);
    first.attacher.stop();
    first.session.close();

    const { attacher, session } = await attachAndEval({ watchIntervalMs: 300 });
    try {
      const deadline = Date.now() + 10_000;
      while (seen.length < 2 && Date.now() < deadline) await sleep(100);
      expect(seen).toEqual(["remove:eyes@C0SMOKE/1757430000.000100", "add:x@C0SMOKE/1757430000.000100"]);
      expect((await loadHistory()).find((h) => h.branch === "fix/broken")?.reacted).toBe("x");
      // The watcher keeps looking; the message is not reacted to again.
      await sleep(1200);
      expect(seen).toHaveLength(2);
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("offers a pull request for a session with commits, and says why it could not push", async () => {
    const worktree = await madeSession("fix/committed", 1);
    await updateSession("fix/committed", { ts: "1757430000.000100", baseBranch: "main" });
    await writeFile(join(worktree, "fix.txt"), "fixed\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    await exec("git", ["add", "."], { cwd: worktree, env });
    await exec("git", ["commit", "-m", "Fix it"], { cwd: worktree, env });

    const { attacher, session } = await attachAndEval({ watchIntervalMs: 300 });
    try {
      await sleep(600);
      const deadline = Date.now() + 10_000;
      let entries = "";
      while (Date.now() < deadline) {
        await hover(session, "row-1");
        await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
        await sleep(150);
        entries = String(await evaluate(session, `Array.from(${UI}.querySelectorAll('.sq-menu button')).map((b) => b.textContent).join('|')`));
        if (entries.includes("Open a pull request for Fix")) break;
        await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
        await sleep(300);
      }
      expect(entries).toContain("Open a pull request for Fix");
      await evaluate(session, `Array.from(${UI}.querySelectorAll('.sq-menu button')).find((b) => b.textContent.includes('Open a pull request')).click()`);
      // The test repo has no origin to push to; the line under the message says so.
      expect(await settledResult(session)).toContain("Could not push fix/committed");
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);
});
