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

/**
 * Everything about the page's own layout that an overlay could disturb. Read
 * once before anything is injected, and again with the overlay running: an
 * overlay that changes any of it is changing Slack's formatting.
 */
const GEOMETRY = `JSON.stringify({
  body: document.body.scrollHeight,
  list: document.getElementById('list').scrollHeight,
  sidebar: document.getElementById('sidebar').scrollHeight,
  rows: Array.from(document.querySelectorAll('[data-qa="virtual-list-item"]')).map((row) => {
    const rect = row.getBoundingClientRect();
    return [Math.round(rect.top), Math.round(rect.height), getComputedStyle(row).position];
  }),
})`;
const PORT = 9333;
const HTTP_PORT = 9334;

let chrome: ChildProcess | null = null;
let server: Server | null = null;
let profileDir = "";
let baseline = "";

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

    profileDir = await mkdtemp(join(tmpdir(), "sidequest-chrome-"));
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

    // Measure the untouched page: nothing has attached to it yet.
    const targets = await listTargets(PORT);
    const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
    if (!page?.webSocketDebuggerUrl) throw new Error("no fixture page target");
    const probe = new CdpSession(page.webSocketDebuggerUrl);
    await probe.connect();
    await probe.send("Runtime.enable");
    for (;;) {
      const ready = await evaluate(probe, "!!document.getElementById('list')");
      if (ready === true) break;
      if (Date.now() > deadline + 15_000) throw new Error("fixture never finished loading");
      await sleep(200);
    }
    baseline = String(await evaluate(probe, GEOMETRY));
    probe.close();
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
    root = await mkdtemp(join(tmpdir(), "sidequest-e2e-"));
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
    process.env.SIDEQUEST_HOME = configHome;
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
    delete process.env.SIDEQUEST_HOME;
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

  async function evaluate(
    session: CdpSession,
    expression: string,
    opts: { userGesture?: boolean } = {},
  ): Promise<unknown> {
    const result = (await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: opts.userGesture === true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      throw new Error(`evaluate threw: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result.result?.value;
  }

  const UI = "document.getElementById('sidequest-layer').shadowRoot";

  /** The overlay only draws on hover, so the tests move a pointer first. */
  async function hover(session: CdpSession, id: string | null): Promise<void> {
    await evaluate(session, `window.__hover(${id ? `'${id}'` : "null"})`);
    // One frame for the placement pass, plus a little slack for CI.
    await sleep(150);
  }

  function shown(selector: string): string {
    return `(() => {
      const el = ${UI}.querySelector('${selector}');
      return !!el && !el.classList.contains('sq-off');
    })()`;
  }

  it("draws its UI in a layer of its own and never writes to Slack's DOM", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await hover(session, "row-1");

      // One inert host at the end of <body> is the overlay's entire footprint.
      const footprint = await evaluate(
        session,
        `(() => {
           const host = document.getElementById('sidequest-layer');
           const rect = host.getBoundingClientRect();
           const style = getComputedStyle(host);
           return JSON.stringify({
             last: document.body.lastElementChild === host,
             width: rect.width,
             height: rect.height,
             position: style.position,
             pointerEvents: style.pointerEvents,
             shadow: !!host.shadowRoot,
           });
         })()`,
      );
      expect(JSON.parse(String(footprint))).toEqual({
        last: true,
        width: 0,
        height: 0,
        position: "fixed",
        pointerEvents: "none",
        shadow: true,
      });

      // Slack's own nodes are untouched: no children, no attributes, no styles.
      const rowChildren = await evaluate(
        session,
        `JSON.stringify(Array.from(document.querySelectorAll('[data-qa=\"virtual-list-item\"]'))
           .map((row) => row.childElementCount))`,
      );
      expect(JSON.parse(String(rowChildren))).toEqual([1, 1, 3, 2]);

      const marks = await evaluate(
        session,
        `(() => {
           const nodes = document.querySelectorAll('body *:not(#sidequest-layer)');
           for (const node of nodes) {
             for (const attr of node.attributes) {
               if (/sidequest|(^|\\s)sq-/.test(attr.name + '=' + attr.value)) return attr.name;
             }
           }
           return '';
         })()`,
      );
      expect(marks).toBe("");

      // And nothing of ours is in a stylesheet that could match a Slack element.
      // The page lays out exactly as it did before anything was injected — which
      // is the whole point: rows keep their height, position and place.
      const after = String(await evaluate(session, GEOMETRY));
      expect(JSON.parse(after)).toEqual(JSON.parse(baseline));

      const leakedCss = await evaluate(
        session,
        `Array.from(document.styleSheets).some((sheet) => {
           try {
             return Array.from(sheet.cssRules).some((rule) => /sidequest|\.sq-/.test(rule.cssText));
           } catch { return false; }
         })`,
      );
      expect(leakedCss).toBe(false);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("offers a message under the pointer, and nothing else", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      // Nothing hovered: the row button stays out of the way.
      await hover(session, null);
      expect(await evaluate(session, shown(".sq-launch"))).toBe(false);

      await hover(session, "row-1");
      expect(await evaluate(session, shown(".sq-launch"))).toBe(true);
      const buttonText = await evaluate(
        session,
        `${UI}.querySelector('.sq-launch').textContent.trim()`,
      );
      expect(buttonText).toBe("Sidequest");

      // The button sits on the hovered row, not somewhere in the void.
      const onRow = await evaluate(
        session,
        `(() => {
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const row = document.getElementById('row-1').getBoundingClientRect();
           return btn.top >= row.top - 2 && btn.bottom <= row.bottom + 2 && btn.right <= row.right;
         })()`,
      );
      expect(onRow).toBe(true);

      // The sidebar is a virtual list with the same data-qa. It is not a message.
      await hover(session, "sidebar-1");
      expect(await evaluate(session, shown(".sq-launch"))).toBe(false);

      // The channel is linked, so the channel button names the repo.
      const label = await evaluate(
        session,
        `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`,
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
      await hover(session, "row-1");

      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const labels = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu button')).map(b => b.textContent))`,
      );
      expect(JSON.parse(String(labels))).toEqual(["Investigate", "Fix", "Review"]);

      // Click "Fix" and wait for the daemon's answer to land on the row.
      await evaluate(
        session,
        `Array.from(${UI}.querySelectorAll('.sq-menu button')).find(b => b.textContent === 'Fix').click()`,
      );

      let text = "";
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        text = String(
          (await evaluate(session, `${UI}.querySelector('.sq-result')?.textContent || ''`)) ?? "",
        );
        if (text && !text.startsWith("Starting")) break;
        await sleep(300);
      }

      // The branch name is built from the message text, which came off the DOM.
      expect(text).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // The result is drawn against the message it belongs to.
      const anchored = await evaluate(
        session,
        `(() => {
           const line = ${UI}.querySelector('.sq-result').getBoundingClientRect();
           const row = document.getElementById('row-1').getBoundingClientRect();
           return Math.abs(line.top - (row.bottom - 6)) < 2;
         })()`,
      );
      expect(anchored).toBe(true);

      const { stdout } = await exec("git", ["branch", "--list"], { cwd: repoPath });
      expect(stdout).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // And the prompt written into the worktree carries the message and the
      // sender the overlay read, not placeholders.
      const worktrees = await exec("git", ["worktree", "list"], { cwd: repoPath });
      const line = worktrees.stdout.split("\n").find((l) => l.includes("fix-checkout"));
      const worktreePath = line?.split(/\s+/)[0] ?? "";
      const prompt = await readFile(join(worktreePath, ".sidequest", "prompt.md"), "utf8");
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

      // Results from earlier tests are still on screen — this page is never
      // reloaded. Clicking one dismisses it, which is also how a reader does it.
      await evaluate(session, `${UI}.querySelectorAll('.sq-result').forEach((el) => el.click())`);
      await sleep(150);
      expect(await evaluate(session, `${UI}.querySelectorAll('.sq-result').length`)).toBe(0);

      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await evaluate(
        session,
        `Array.from(${UI}.querySelectorAll('.sq-menu button')).find(b => b.textContent === 'Investigate').click()`,
      );

      let text = "";
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        text = String(
          (await evaluate(session, `${UI}.querySelector('.sq-result')?.textContent || ''`)) ?? "",
        );
        if (text && !text.startsWith("Starting")) break;
        await sleep(300);
      }
      expect(text).toContain("investigate/only-on-the-eu-store");

      // Slack recycles the row into a different message.
      await evaluate(session, "window.__recycle('row-2', 'something else entirely', '1757439999.000900')");
      await sleep(800);

      // The old result must not still be sitting under someone else's message.
      const results = await evaluate(session, `${UI}.querySelectorAll('.sq-result').length`);
      expect(results).toBe(0);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("links a channel from its own panel, without window.prompt", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('release-train')");
      await sleep(400);

      const before = await evaluate(
        session,
        `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`,
      );
      expect(before).toBe("Link a repo");

      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);
      await sleep(150);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-panel input')`)).toBe(true);

      await evaluate(
        session,
        `(() => {
           const input = ${UI}.querySelector('.sq-panel input');
           input.value = ${JSON.stringify(repoPath)};
           Array.from(${UI}.querySelectorAll('.sq-panel-actions button'))
             .find(b => b.textContent === 'Link').click();
         })()`,
      );

      let label = "";
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        label = String(
          (await evaluate(
            session,
            `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`,
          )) ?? "",
        );
        if (label === "repo") break;
        await sleep(250);
      }
      expect(label).toBe("repo");
      // The panel closes itself once the daemon has stored the link.
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-panel')`)).toBe(false);

      const stored = JSON.parse(await readFile(join(configHome, "config.json"), "utf8"));
      expect(stored.channels["release-train"].repoPath).toBe(repoPath);
    } finally {
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("refuses to offer prompts in a channel with no repo", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('random-chatter')");
      await sleep(400);

      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);

      const note = await evaluate(
        session,
        `${UI}.querySelector('.sq-menu .sq-note')?.textContent || ''`,
      );
      expect(String(note)).toContain("no repo yet");

      const buttons = await evaluate(session, `${UI}.querySelectorAll('.sq-menu button').length`);
      expect(buttons).toBe(0);
    } finally {
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  /**
   * Slack's own clipboard and key handling sits on the document in capture,
   * and an event out of the overlay's shadow root arrives there retargeted to
   * the host — near enough to a paste into the channel that Slack takes it.
   * The fixture stands in for that, so these two say the path box gets its
   * paste anyway: once as the key's own editing command, and once for an app
   * that swallows the shortcut and never lets a paste through at all.
   */
  it("takes a paste into the path box before Slack can take it", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('paste-lane')");
      await sleep(400);
      await evaluate(session, "window.__composer.length = 0; window.__shortcuts.length = 0");
      expect(await evaluate(session, `window.__clip(${JSON.stringify(repoPath)})`, {
        userGesture: true,
      })).toBe(true);

      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);
      await sleep(150);
      const focused = await evaluate(
        session,
        `${UI}.activeElement === ${UI}.querySelector('.sq-panel input')`,
      );
      expect(focused).toBe(true);

      const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 };
      // A real paste: the editing command the key would run, not a synthesised
      // event, so the browser's own insertion is what fills the box.
      await session.send("Input.dispatchKeyEvent", {
        ...key,
        type: "keyDown",
        commands: ["paste"],
      });
      await session.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
      await sleep(200);

      expect(await evaluate(session, `${UI}.querySelector('.sq-panel input').value`))
        .toBe(repoPath);
      // And Slack saw neither the paste nor the keystroke behind it.
      expect(await evaluate(session, "window.__composer.length")).toBe(0);
      expect(await evaluate(session, "window.__shortcuts.length")).toBe(0);
    } finally {
      await evaluate(session, `${UI}.querySelector('.sq-panel-actions button')?.click()`);
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("reads the clipboard itself when the paste never arrives", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('paste-lane')");
      await sleep(400);
      await evaluate(session, "window.__composer.length = 0; window.__shortcuts.length = 0");
      await evaluate(
        session,
        `Object.defineProperty(navigator, 'clipboard', {
           configurable: true,
           value: { readText: async () => ${JSON.stringify(repoPath)} },
         })`,
      );

      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);
      await sleep(150);

      // A shortcut with no editing command behind it: the key arrives, the
      // paste never does.
      await evaluate(
        session,
        `${UI}.querySelector('.sq-panel input').dispatchEvent(new KeyboardEvent('keydown', {
           key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, composed: true, cancelable: true,
         }))`,
      );
      await sleep(300);

      expect(await evaluate(session, `${UI}.querySelector('.sq-panel input').value`))
        .toBe(repoPath);
      expect(await evaluate(session, "window.__shortcuts.length")).toBe(0);
    } finally {
      await evaluate(session, `${UI}.querySelector('.sq-panel-actions button')?.click()`);
      await evaluate(session, "delete navigator.clipboard");
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);
});
