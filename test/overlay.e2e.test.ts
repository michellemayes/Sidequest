import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { CdpSession, listTargets, devtoolsVersion } from "../src/cdp/client.js";
import { Attacher } from "../src/cdp/attacher.js";
import { sleep } from "../src/cdp/launch.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  process.env.CHROME_PATH ?? "",
].filter((p) => p.length > 0);

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const PORT = 9333;
const HTTP_PORT = 9334;

let chrome: ChildProcess | null = null;
let server: Server | null = null;
let profileDir = "";

/**
 * These exercise the real CDP path — a real browser, the real injected
 * overlay, the real Attacher — because that plumbing is the part unit tests
 * cannot speak for. Chromium stands in for Slack's Electron renderer, which is
 * the same engine driven the same way.
 */
const describeIfChrome = CHROME ? describe : describe.skip;

describeIfChrome("overlay over CDP", () => {
  let root: string;
  let repoPath: string;
  let configHome: string;

  beforeAll(async () => {
    const fixture = await readFile(join(HERE, "fixture.html"), "utf8");
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixture);
    });
    await new Promise<void>((resolve) => server!.listen(HTTP_PORT, "127.0.0.1", resolve));

    profileDir = await mkdtemp(join(tmpdir(), "ccslack-chrome-"));
    chrome = spawn(
      CHROME!,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profileDir}`,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        `http://127.0.0.1:${HTTP_PORT}/`,
      ],
      { stdio: "ignore" },
    );

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await devtoolsVersion(PORT);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("chromium did not open its DevTools port");
        await sleep(250);
      }
    }
  }, 60_000);

  afterAll(async () => {
    // Wait for the process to actually be gone: Chromium keeps writing to its
    // profile as it dies, and removing the directory under it fails with
    // ENOTEMPTY.
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise<void>((resolve) => chrome!.once("exit", () => resolve()));
      chrome.kill("SIGKILL");
      await Promise.race([exited, sleep(5000)]);
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    // Best-effort: a leftover temp profile is not worth failing a green suite.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => undefined);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ccslack-e2e-"));
    configHome = join(root, "config");
    repoPath = join(root, "repo");
    await mkdir(repoPath, { recursive: true });
    await mkdir(configHome, { recursive: true });

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    await exec("git", ["init", "--initial-branch=main"], { cwd: repoPath, env });
    await writeFile(join(repoPath, "README.md"), "# test\n");
    await exec("git", ["add", "."], { cwd: repoPath, env });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoPath, env });

    // The daemon reads config from here; point it at a fresh dir per test.
    process.env.CCSLACK_HOME = configHome;
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        version: 1,
        settings: {
          worktreesRoot: join(root, "worktrees"),
          // Nothing can open a warp:// URI in CI, so the launch is expected to
          // fail; the session must still be created and reported.
          warpStrategy: "new_tab",
          fetchBeforeCreate: false,
          claudeCommand: "true",
        },
        channels: {
          "eng-alerts": { repoPath, channel: "eng-alerts", baseBranch: "", label: "" },
        },
      }),
    );
  });

  afterEach(async () => {
    delete process.env.CCSLACK_HOME;
    await rm(root, { recursive: true, force: true });
  });

  async function attachAndEval(): Promise<{ attacher: Attacher; session: CdpSession }> {
    const attacher = new Attacher({ cdpPort: PORT, targetUrlPattern: "127\\.0\\.0\\.1" });
    await attacher.start();

    const targets = await listTargets(PORT);
    const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
    if (!page?.webSocketDebuggerUrl) throw new Error("no fixture page target");

    const session = new CdpSession(page.webSocketDebuggerUrl);
    await session.connect();
    await session.send("Runtime.enable");
    return { attacher, session };
  }

  async function evaluate(session: CdpSession, expression: string): Promise<unknown> {
    const result = (await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      throw new Error(`evaluate threw: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result.result?.value;
  }

  it("injects a launch button onto every message", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      const count = await evaluate(session, "document.querySelectorAll('.ccslack-launch').length");
      expect(count).toBe(2);

      // The channel is linked, so the header button names the repo.
      const label = await evaluate(
        session,
        "document.querySelector('.ccslack-channel .ccslack-channel-label').textContent",
      );
      expect(label).toBe("repo");
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("opens the three prompts and starts a real session on click", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      await evaluate(session, "document.querySelector('#row-1 .ccslack-launch').click()");
      const labels = await evaluate(
        session,
        "JSON.stringify(Array.from(document.querySelectorAll('#row-1 .ccslack-menu button')).map(b => b.textContent))",
      );
      expect(JSON.parse(String(labels))).toEqual(["Investigate", "Fix", "Review"]);

      // Click "Fix" and wait for the daemon's answer to land on the row.
      await evaluate(
        session,
        "Array.from(document.querySelectorAll('#row-1 .ccslack-menu button')).find(b => b.textContent === 'Fix').click()",
      );

      let text = "";
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        text = String(
          (await evaluate(session, "document.querySelector('#row-1 .ccslack-result')?.textContent || ''")) ?? "",
        );
        if (text && !text.startsWith("Starting")) break;
        await sleep(300);
      }

      // The branch name is built from the message text, which came off the DOM.
      expect(text).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      const { stdout } = await exec("git", ["branch", "--list"], { cwd: repoPath });
      expect(stdout).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // And the prompt written into the worktree carries the message and the
      // sender the overlay read, not placeholders.
      const worktrees = await exec("git", ["worktree", "list"], { cwd: repoPath });
      const line = worktrees.stdout.split("\n").find((l) => l.includes("fix-checkout"));
      const worktreePath = line?.split(/\s+/)[0] ?? "";
      const prompt = await readFile(join(worktreePath, ".ccslack", "prompt.md"), "utf8");
      expect(prompt).toContain("Checkout total is wrong for gift cards");
      expect(prompt).toContain("@michelle");
      expect(prompt).toContain("#eng-alerts");
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("drops a stale result when the virtual list recycles a row", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      // Put a result line on row-1, as a finished session would.
      await evaluate(
        session,
        `(() => {
           const row = document.querySelector('#row-1');
           const line = document.createElement('div');
           line.className = 'ccslack-result';
           line.dataset.sig = '1757430000.000100';
           line.textContent = 'Fix → fix/old-branch';
           row.appendChild(line);
         })()`,
      );
      expect(
        await evaluate(session, "!!document.querySelector('#row-1 .ccslack-result')"),
      ).toBe(true);

      // Slack recycles the row into a different message.
      await evaluate(session, "window.__recycle('row-1', 'something else entirely', '1757439999.000900')");
      await sleep(800);

      // The old result must not still be sitting under someone else's message.
      expect(
        await evaluate(session, "!!document.querySelector('#row-1 .ccslack-result')"),
      ).toBe(false);
      // The button survives the recycle.
      expect(
        await evaluate(session, "!!document.querySelector('#row-1 .ccslack-launch')"),
      ).toBe(true);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("refuses to offer prompts in a channel with no repo", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('random-chatter')");
      await sleep(800);

      await evaluate(session, "document.querySelector('#row-2 .ccslack-launch').click()");
      const note = await evaluate(
        session,
        "document.querySelector('#row-2 .ccslack-menu .ccslack-menu-note')?.textContent || ''",
      );
      expect(String(note)).toContain("no repo yet");

      const buttons = await evaluate(
        session,
        "document.querySelectorAll('#row-2 .ccslack-menu button').length",
      );
      expect(buttons).toBe(0);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);
});
