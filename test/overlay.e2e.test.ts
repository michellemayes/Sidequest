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
/** Bodies of what the overlay posted to the fixture's stand-in for Slack's API. */
const posts: string[] = [];

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
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/chat.postMessage") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          posts.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/conversations.info") {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, channel: { id: "C0SMOKE", name: "eng-alerts" } }));
        });
        return;
      }
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
    // Read it twice and wait for the two to agree: the page is still settling
    // right after load, and a baseline measured mid-settle fails against a
    // perfectly innocent overlay.
    for (;;) {
      const first = String(await evaluate(probe, GEOMETRY));
      await sleep(250);
      const second = String(await evaluate(probe, GEOMETRY));
      if (first === second) {
        baseline = second;
        break;
      }
      if (Date.now() > deadline + 15_000) throw new Error("fixture layout never settled");
    }
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
    posts.length = 0;
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
          agent: { id: "claude", command: "true", args: [] },
          // Suggestions look here, and only here, for checkouts.
          repoSearchRoots: [root],
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

  /**
   * Whether any shown overlay element matching `selector` covers the text of
   * a row — the words someone wrote, not just the row's box.
   */
  function coversText(selector: string, rowId: string): string {
    return `(() => {
      const content = document.getElementById('${rowId}').querySelector('[data-qa="message_content"]');
      const range = document.createRange();
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const ink = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        range.selectNodeContents(n);
        ink.push(...Array.from(range.getClientRects()));
      }
      return Array.from(${UI}.querySelectorAll('${selector}'))
        .filter((el) => !el.classList.contains('sq-off'))
        .map((el) => el.getBoundingClientRect())
        .some((a) => ink.some((b) =>
          a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
    })()`;
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
      expect(JSON.parse(String(rowChildren))).toEqual([1, 1, 3, 2, 3, 2]);

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

      // The button sits on the hovered row, not somewhere in the void — and at
      // the row's bottom edge, because Slack's own hover actions and an unread
      // divider's "New" label both own the top-right corner.
      const onRow = await evaluate(
        session,
        `(() => {
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const row = document.getElementById('row-1').getBoundingClientRect();
           return JSON.stringify({
             inside: btn.top >= row.top - 2 && btn.bottom <= row.bottom + 2 && btn.right <= row.right,
             offTopRight: btn.top - row.top >= 12,
             onBottom: Math.abs(row.bottom - btn.bottom) <= 4,
           });
         })()`,
      );
      expect(JSON.parse(String(onRow))).toEqual({
        inside: true,
        offTopRight: true,
        onBottom: true,
      });

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

  it("opens the prompts and starts a real session on click", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await hover(session, "row-1");

      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const labels = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => b.textContent))`,
      );
      expect(JSON.parse(String(labels))).toEqual(["Investigate", "Fix", "Review", "Ask"]);

      // The menu hangs off the button, clear of the message it was opened from.
      // Dropping it across that message hid the thing being acted on.
      const clearOfMessage = await evaluate(
        session,
        `(() => {
           const menu = ${UI}.querySelector('.sq-menu').getBoundingClientRect();
           const row = document.getElementById('row-1').getBoundingClientRect();
           return menu.top >= row.bottom - 1;
         })()`,
      );
      expect(clearOfMessage).toBe(true);

      // Click "Fix" and wait for the daemon's answer to land on the row.
      await evaluate(
        session,
        `Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).find(b => b.textContent === 'Fix').click()`,
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

      // The result is drawn against the message it belongs to, at its bottom
      // edge: beside the last line where the words leave room, on a line of
      // its own under them where they do not. Never over what anyone wrote.
      const anchored = await evaluate(
        session,
        `(() => {
           const line = ${UI}.querySelector('.sq-result').getBoundingClientRect();
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const row = document.getElementById('row-1').getBoundingClientRect();
           return JSON.stringify({
             atBottom: Math.abs(row.bottom - line.bottom) <= line.height,
             clearOfButton: line.right <= btn.left - 2 || line.top >= btn.bottom - 1,
           });
         })()`,
      );
      expect(JSON.parse(String(anchored))).toEqual({ atBottom: true, clearOfButton: true });
      expect(await evaluate(session, coversText(".sq-result", "row-1"))).toBe(false);
      expect(await evaluate(session, coversText(".sq-result", "row-2"))).toBe(false);

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

  it("keeps the pill and the line off a message's text, on a line of their own", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);

      // Every line of row-4 runs to the right edge, so the pill has nowhere
      // beside the words to go.
      await hover(session, "row-4");
      expect(await evaluate(session, shown(".sq-launch"))).toBe(true);
      expect(await evaluate(session, coversText(".sq-launch", "row-4"))).toBe(false);
      const underText = await evaluate(
        session,
        `(() => {
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const text = document.querySelector('#row-4 .p-rich_text_section').getBoundingClientRect();
           return btn.top >= text.bottom;
         })()`,
      );
      expect(underText).toBe(true);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("keeps the pill off the composer under the last message", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await evaluate(session, "window.__pinToComposer(true)");
      await sleep(100);

      // row-4 runs edge to edge and sits right on the composer: no room
      // beside its words, and none under them. The pill stays in its corner
      // of the message rather than hanging over the composer.
      await hover(session, "row-4");
      expect(await evaluate(session, shown(".sq-launch"))).toBe(true);
      const placed = await evaluate(
        session,
        `(() => {
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const composer = document.getElementById('composer').getBoundingClientRect();
           const chips = document.querySelector('#composer .chips').getBoundingClientRect();
           const row = document.getElementById('row-4').getBoundingClientRect();
           const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
           return JSON.stringify({
             offComposer: !hits(btn, composer) && !hits(btn, chips),
             inRow: btn.top >= row.top && btn.bottom <= row.bottom,
             atRight: row.right - btn.right <= 16,
           });
         })()`,
      );
      expect(JSON.parse(String(placed))).toEqual({ offComposer: true, inRow: true, atRight: true });
    } finally {
      await evaluate(session, "window.__pinToComposer(false)");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("offers a Linear prompt on a message that links an issue, and works it", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);

      // Not on a message with no ticket in it.
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const plain = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => b.textContent))`,
      );
      expect(JSON.parse(String(plain))).toEqual(["Investigate", "Fix", "Review", "Ask"]);
      await press(session, "Escape", "Escape", 27);

      await hover(session, "row-3");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const entries = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => [b.textContent, b.dataset.key, b.dataset.letter || '']))`,
      );
      expect(JSON.parse(String(entries))).toEqual([
        ["Investigate", "1", "i"],
        ["Fix", "2", "f"],
        ["Review", "3", "r"],
        ["Ask", "4", "a"],
        ["Linear DATA-3051", "5", "l"],
      ]);

      await press(session, "5", "Digit5", 53);
      const text = await settledResult(session);
      // Named for the ticket, so Linear links the branch back to it.
      expect(text).toContain("Linear DATA-3051 → linear/data-3051-quiet-the-flapping-alarm");
      // And the line has its own line, under a message that runs edge to edge.
      expect(await evaluate(session, coversText(".sq-result", "row-3"))).toBe(false);
      expect(await evaluate(session, coversText(".sq-result", "row-4"))).toBe(false);

      const worktrees = await exec("git", ["worktree", "list"], { cwd: repoPath });
      const line = worktrees.stdout.split("\n").find((l) => l.includes("data-3051"));
      const prompt = await readFile(join(line!.split(/\s+/)[0]!, ".sidequest", "prompt.md"), "utf8");
      expect(prompt).toContain("DATA-3051: https://linear.app/acme/issue/DATA-3051/quiet-the-flapping-alarm");
      expect(prompt).toContain("@pam");
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("offers GitHub and Jira prompts on a message that links their issues, and works them", async () => {
    const { attacher, session } = await attachAndEval();
    const section = "document.querySelector('#row-2 .p-rich_text_section')";
    const original = String(await evaluate(session, `${section}.innerHTML`));
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      // A message of its own, linking three tickets: only the first two are offered.
      await evaluate(session, "window.__recycle('row-2', 'x', '1757438888.000800')");
      await evaluate(
        session,
        `${section}.innerHTML = 'Dupe of <a href="https://github.com/acme/web/issues/123">#123</a>, tracked in ' +
          '<a href="https://acme.atlassian.net/browse/OPS-7">OPS-7</a> and <a href="https://github.com/acme/web/issues/124">#124</a>'`,
      );
      await sleep(300);

      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const entries = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => [b.textContent, b.dataset.key, b.dataset.letter || '']))`,
      );
      expect(JSON.parse(String(entries))).toEqual([
        ["Investigate", "1", "i"],
        ["Fix", "2", "f"],
        ["Review", "3", "r"],
        ["Ask", "4", "a"],
        ["GitHub #123", "5", "g"],
        ["Jira OPS-7", "6", "j"],
      ]);

      await press(session, "j", "KeyJ", 74);
      const jira = await settledResult(session);
      // The key leads the branch, upper-case, so Jira's development panel finds it.
      expect(jira).toContain("Jira OPS-7 → jira/OPS-7-dupe-of-123");

      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "g", "KeyG", 71);
      const github = await settledResult(session);
      expect(github).toContain("GitHub #123 → issue/123-dupe-of-123");

      const worktrees = (await exec("git", ["worktree", "list"], { cwd: repoPath })).stdout.split("\n");
      const promptOf = (branch: string) => {
        const line = worktrees.find((l) => l.includes(`[${branch}`));
        return readFile(join(line!.split(/\s+/)[0]!, ".sidequest", "prompt.md"), "utf8");
      };
      const jiraPrompt = await promptOf("jira/OPS-7-");
      expect(jiraPrompt).toContain("OPS-7: https://acme.atlassian.net/browse/OPS-7");
      const githubPrompt = await promptOf("issue/123-");
      expect(githubPrompt).toContain("acme/web#123: https://github.com/acme/web/issues/123");
      expect(githubPrompt).toContain('"Fixes acme/web#123"');
    } finally {
      await evaluate(session, `${section}.innerHTML = ${JSON.stringify(original)}`);
      await evaluate(session, "window.__recycle('row-2', 'only on the EU store', '1757430060.000200')");
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      attacher.stop();
      session.close();
    }
  }, 60_000);

  it("drops a stale result when the virtual list recycles a row", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      // Results from earlier tests are still on screen — this page is never
      // reloaded. Their × dismisses them, which is also how a reader does it.
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await sleep(150);
      expect(await evaluate(session, `${UI}.querySelectorAll('.sq-result').length`)).toBe(0);

      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await evaluate(
        session,
        `Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).find(b => b.textContent === 'Investigate').click()`,
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
      expect(stored.channels["release-train"][0].repoPath).toBe(repoPath);
    } finally {
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("keeps the channel pill off Slack's own header controls", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      // Room to spare beside the name: the pill shows its label, follows the
      // name's control rather than the bare text, and touches nothing.
      const roomy = await evaluate(
        session,
        `(() => {
           const pill = ${UI}.querySelector('.sq-channel');
           const rect = pill.getBoundingClientRect();
           const name = document.querySelector('[data-qa="channel_name"]').getBoundingClientRect();
           const control = document.getElementById('name-control').getBoundingClientRect();
           const hits = ['huddle', 'more', 'name-control'].filter((id) => {
             const other = document.getElementById(id).getBoundingClientRect();
             return rect.right > other.left && rect.left < other.right
               && rect.bottom > other.top && rect.top < other.bottom;
           });
           return JSON.stringify({
             hidden: pill.classList.contains('sq-off'),
             compact: pill.dataset.compact === '1',
             afterControl: rect.left >= control.right,
             pastText: rect.left > name.right,
             hits,
           });
         })()`,
      );
      expect(JSON.parse(String(roomy))).toEqual({
        hidden: false,
        compact: false,
        afterControl: true,
        pastText: true,
        hits: [],
      });

      // Narrow enough for a label but not the whole one: it truncates rather
      // than reaching across Slack's buttons.
      await evaluate(session, "window.__crowdHeader(90)");
      await sleep(400);
      const tight = await evaluate(
        session,
        `(() => {
           const pill = ${UI}.querySelector('.sq-channel');
           const rect = pill.getBoundingClientRect();
           const huddle = document.getElementById('huddle').getBoundingClientRect();
           return JSON.stringify({ hidden: pill.classList.contains('sq-off'), clear: rect.right <= huddle.left });
         })()`,
      );
      expect(JSON.parse(String(tight))).toEqual({ hidden: false, clear: true });

      // No room at all: the pill gets out of the way entirely. Linking is still
      // reachable from the message menu and from the CLI.
      await evaluate(session, "window.__crowdHeader(4)");
      await sleep(400);
      expect(await evaluate(session, shown(".sq-channel"))).toBe(false);
    } finally {
      await evaluate(session, "window.__crowdHeader(260)");
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
      expect(String(note)).toContain("No repo is linked to #random-chatter");

      const prompts = await evaluate(session, `${UI}.querySelectorAll('.sq-menu-prompt').length`);
      expect(prompts).toBe(0);

      // A sentence must not stretch the menu into a bar across the message
      // underneath it; it wraps inside a menu-sized menu instead.
      const width = await evaluate(
        session,
        `${UI}.querySelector('.sq-menu').getBoundingClientRect().width`,
      );
      expect(Number(width)).toBeLessThanOrEqual(268);

      // Sending the reader off to find another button is a dead end, so the
      // menu carries the way out itself.
      const link = await evaluate(session, `${UI}.querySelector('.sq-menu-link')?.textContent || ''`);
      expect(String(link)).toBe("Link a repo…");

      await evaluate(session, `${UI}.querySelector('.sq-menu-link').click()`);
      await sleep(200);
      const panel = await evaluate(
        session,
        `${UI}.querySelector('.sq-panel-title')?.textContent || ''`,
      );
      expect(String(panel)).toBe("Repo for #random-chatter");
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
  /** Wait for the line on a message to stop saying it is starting. */
  async function settledResult(session: CdpSession): Promise<string> {
    let text = "";
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      text = String(
        (await evaluate(
          session,
          `${UI}.querySelector('.sq-result:not([data-kind="busy"]) .sq-result-text')?.textContent || ''`,
        )) ?? "",
      );
      if (text) break;
      await sleep(300);
    }
    return text;
  }

  async function press(session: CdpSession, key: string, code: string, keyCode: number): Promise<void> {
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }

  it("starts a session from the keyboard, celebrates it, and marks the message", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await evaluate(session, "window.__shortcuts.length = 0");

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);

      // Each prompt wears its key, and its text is still just its label.
      const keys = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => [b.textContent, b.dataset.key]))`,
      );
      expect(JSON.parse(String(keys))).toEqual([["Investigate", "1"], ["Fix", "2"], ["Review", "3"], ["Ask", "4"]]);

      await press(session, "3", "Digit3", 51);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(false);
      // The key picked a prompt; Slack never saw it.
      expect(await evaluate(session, "window.__shortcuts.length")).toBe(0);

      expect(await settledResult(session)).toContain("review/checkout-total-is-wrong-for-gift-cards");

      // The history for this test is fresh, so this is the first one ever.
      const toast = await evaluate(session, `${UI}.querySelector('.sq-toast-title')?.textContent || ''`);
      expect(String(toast)).toBe("Your first sidequest is underway");
      // Thread replies are off unless asked for.
      expect(posts).toEqual([]);

      // Once the line is dismissed, the message keeps a quiet mark instead…
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await sleep(300);
      const mark = await evaluate(session, `(() => {
        const marks = Array.from(${UI}.querySelectorAll('.sq-mark')).filter((m) => !m.classList.contains('sq-off'));
        const row = document.getElementById('row-1').getBoundingClientRect();
        const hit = marks.find((m) => {
          const r = m.getBoundingClientRect();
          return r.top >= row.top - 1 && r.bottom <= row.bottom + 1;
        });
        return hit ? hit.textContent : '';
      })()`);
      expect(String(mark)).toMatch(/^Review/);

      // …and its menu offers the way back before the way forward.
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const first = await evaluate(session, `${UI}.querySelector('.sq-menu button')?.className || ''`);
      expect(String(first)).toBe("sq-menu-reopen");
      const back = await evaluate(session, `${UI}.querySelector('.sq-menu-reopen').textContent`);
      expect(String(back)).toContain("Back to Review");
      await press(session, "Escape", "Escape", 27);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(false);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("replies in the message's thread, as you, when autoReply is on", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.settings.autoReply = true;
    config.prompts = { review: { reply: "Reviewing this in {{repo}}." } };
    await writeFile(file, JSON.stringify(config));

    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      // Slack's client keeps the workspace and its session token here.
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
      }))`);

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "3", "Digit3", 51);
      expect(await settledResult(session)).toContain("review/checkout-total-is-wrong-for-gift-cards");

      const deadline = Date.now() + 5000;
      while (posts.length === 0 && Date.now() < deadline) await sleep(100);
      expect(posts).toHaveLength(1);
      const field = (name: string) =>
        posts[0]!.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
      expect(field("token")).toBe("xoxc-test");
      expect(field("channel")).toBe("C0SMOKE");
      expect(field("thread_ts")).toBe("1757430000.000100");
      expect(field("text")).toBe("Reviewing this in repo.");
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("works in the message's own channel's repo from Threads, not the page's", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
      }))`);
      // Threads mixes channels under one page, and whatever channel name the
      // page still shows is not the message's.
      await evaluate(session, "history.pushState({}, '', '/client/T0SMOKE/threads')");
      await evaluate(session, "window.__setChannel('random-chatter')");
      await sleep(400);

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(400);

      const note = await evaluate(session, `${UI}.querySelector('.sq-menu .sq-note')?.textContent || ''`);
      expect(String(note)).toBe("");
      expect(Number(await evaluate(session, `${UI}.querySelectorAll('.sq-menu-prompt').length`))).toBeGreaterThan(0);

      await press(session, "2", "Digit2", 50);
      expect(await settledResult(session)).toContain("fix/checkout-total-is-wrong-for-gift-cards");
      const branches = await exec("git", ["branch", "--list"], { cwd: repoPath });
      expect(branches.stdout).toContain("fix/checkout-total-is-wrong-for-gift-cards");
    } finally {
      await evaluate(session, "history.pushState({}, '', '/')").catch(() => undefined);
      await evaluate(session, "window.__setChannel('eng-alerts')").catch(() => undefined);
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("takes a question for Ask in the menu itself, and hands it to the agent", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await evaluate(session, "window.__shortcuts.length = 0");

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);

      // Picking Ask opens a box in the menu rather than starting straight away.
      await press(session, "4", "Digit4", 52);
      await sleep(100);
      const state = await evaluate(session, `JSON.stringify({
        box: !!${UI}.querySelector('.sq-menu .sq-ask-input'),
        focused: ${UI}.activeElement?.className || '',
        prompts: ${UI}.querySelectorAll('.sq-menu-prompt').length,
      })`);
      expect(JSON.parse(String(state))).toEqual({ box: true, focused: "sq-ask-input", prompts: 0 });

      // A digit typed into the box is part of the question, not a menu pick,
      // and none of it reaches Slack.
      await session.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "2", code: "Digit2", windowsVirtualKeyCode: 50, text: "2",
      });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "2", code: "Digit2", windowsVirtualKeyCode: 50 });
      await session.send("Input.insertText", { text: " gift cards at once — why is the total off?" });
      expect(await evaluate(session, `${UI}.querySelector('.sq-ask-input').value`))
        .toBe("2 gift cards at once — why is the total off?");
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(true);

      await press(session, "Enter", "Enter", 13);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(false);
      expect(await evaluate(session, "window.__shortcuts.length")).toBe(0);
      expect(await settledResult(session)).toContain("Ask → ask/checkout-total-is-wrong-for-gift-cards");

      const worktrees = await exec("git", ["worktree", "list"], { cwd: repoPath });
      const line = worktrees.stdout.split("\n").find((l) => l.includes("ask-checkout"));
      const prompt = await readFile(join(line!.split(/\s+/)[0]!, ".sidequest", "prompt.md"), "utf8");
      expect(prompt).toContain("## My question\n2 gift cards at once — why is the total off?");
      expect(prompt).toContain("Checkout total is wrong for gift cards");
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("closes the Ask box on Escape without starting anything", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await evaluate(session, `Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).find(b => b.textContent === 'Ask').click()`);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-ask-input')`)).toBe(true);

      await press(session, "Escape", "Escape", 27);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(false);
      expect(await evaluate(session, `${UI}.querySelectorAll('.sq-result').length`)).toBe(0);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("offers the channel's own repo in the menu and goes straight on to the prompts", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      // The test repo's directory is called "repo", so #repo-eng is its channel.
      await evaluate(session, "window.__setChannel('repo-eng')");
      await sleep(400);

      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);

      let pick = "";
      const deadline = Date.now() + 10_000;
      while (!pick && Date.now() < deadline) {
        await sleep(150);
        pick = String(
          (await evaluate(session, `${UI}.querySelector('.sq-menu-suggest')?.textContent || ''`)) ?? "",
        );
      }
      expect(pick).toContain("Link repo");
      // The suggestions sit above the fallback, which is still there.
      expect(await evaluate(session, `${UI}.querySelector('.sq-menu-link').textContent`)).toBe("Link a repo…");

      await evaluate(session, `${UI}.querySelector('.sq-menu-suggest').click()`);

      let prompts = 0;
      const until = Date.now() + 10_000;
      while (prompts === 0 && Date.now() < until) {
        await sleep(200);
        prompts = Number(await evaluate(session, `${UI}.querySelectorAll('.sq-menu-prompt').length`));
      }
      // Linked, and the menu came back on the same message ready to go.
      expect(prompts).toBe(4);
      const stored = JSON.parse(await readFile(join(configHome, "config.json"), "utf8"));
      expect(stored.channels["repo-eng"][0].repoPath).toBe(repoPath);
    } finally {
      await evaluate(session, `${UI}.querySelector('.sq-menu') && document.body.click()`);
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  it("filters the panel's repo list as you type, and links on Enter", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__setChannel('type-ahead')");
      await sleep(400);
      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);

      let names = "";
      const deadline = Date.now() + 10_000;
      while (!names && Date.now() < deadline) {
        await sleep(150);
        names = String(
          (await evaluate(
            session,
            `Array.from(${UI}.querySelectorAll('.sq-suggest-name')).map((n) => n.textContent).join(',')`,
          )) ?? "",
        );
      }
      expect(names.split(",")).toContain("repo");

      await evaluate(session, `(() => {
        const input = ${UI}.querySelector('.sq-panel input');
        input.value = 'nothing-matches-this';
        input.dispatchEvent(new Event('input'));
      })()`);
      await sleep(100);
      expect(await evaluate(session, `${UI}.querySelectorAll('.sq-suggest').length`)).toBe(0);

      await evaluate(session, `(() => {
        const input = ${UI}.querySelector('.sq-panel input');
        input.value = 'rep';
        input.dispatchEvent(new Event('input'));
        input.focus();
      })()`);
      await sleep(100);
      expect(await evaluate(session, `${UI}.querySelector('.sq-suggest[data-active="1"] .sq-suggest-name')?.textContent`))
        .toBe("repo");

      await press(session, "Enter", "Enter", 13);
      let label = "";
      const until = Date.now() + 10_000;
      while (label !== "repo" && Date.now() < until) {
        await sleep(200);
        label = String(
          (await evaluate(session, `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`)) ?? "",
        );
      }
      expect(label).toBe("repo");
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-panel')`)).toBe(false);
    } finally {
      await evaluate(session, `${UI}.querySelector('.sq-panel-actions button')?.click()`);
      await evaluate(session, "window.__setChannel('eng-alerts')");
      attacher.stop();
      session.close();
    }
  }, 30_000);

  /** A second checkout next to the test repo, linked to #eng-alerts after it. */
  async function linkSecondRepo(): Promise<string> {
    const apiPath = join(root, "api");
    await mkdir(apiPath, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    await exec("git", ["init", "--initial-branch=main"], { cwd: apiPath, env });
    await writeFile(join(apiPath, "README.md"), "# api\n");
    await exec("git", ["add", "."], { cwd: apiPath, env });
    await exec("git", ["commit", "-m", "initial"], { cwd: apiPath, env });

    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.channels["eng-alerts"] = [
      config.channels["eng-alerts"],
      { repoPath: apiPath, channel: "eng-alerts", baseBranch: "", label: "" },
    ];
    await writeFile(file, JSON.stringify(config));
    return apiPath;
  }

  it("asks which repo in a channel with several, and starts the session there", async () => {
    const apiPath = await linkSecondRepo();
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      // The fixture page outlives each test, overlay and all; hand it this config.
      await attacher.broadcastConfig();
      await sleep(150);
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);

      // The pill says there is more than one.
      expect(await evaluate(session, `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`))
        .toBe("repo +1");

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);

      const chips = () => evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-repo')).map(b => [b.textContent, b.dataset.on === '1']))`,
      ).then((v) => JSON.parse(String(v)));
      // The default is picked until the reader picks another.
      expect(await chips()).toEqual([["repo", true], ["api", false]]);
      // Picking a repo is not a prompt: the digits still mean the same prompts.
      const keys = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => b.dataset.key))`,
      );
      expect(JSON.parse(String(keys))).toEqual(["1", "2", "3", "4"]);

      await press(session, "ArrowRight", "ArrowRight", 39);
      expect(await chips()).toEqual([["repo", false], ["api", true]]);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(true);

      await press(session, "2", "Digit2", 50);
      const text = await settledResult(session);
      expect(text).toContain("Fix in api");
      expect(text).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // Cut in the picked repo, and only there.
      const api = await exec("git", ["branch", "--list"], { cwd: apiPath });
      expect(api.stdout).toContain("fix/checkout-total-is-wrong-for-gift-cards");
      const main = await exec("git", ["branch", "--list"], { cwd: repoPath });
      expect(main.stdout).not.toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // The next menu in this channel opens on the repo just used.
      await evaluate(session, `${UI}.querySelectorAll('.sq-result-x').forEach((el) => el.click())`);
      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      expect(await chips()).toEqual([["repo", false], ["api", true]]);
      await press(session, "Escape", "Escape", 27);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("lists a channel's repos in its panel, and unlinks one without the others", async () => {
    const apiPath = await linkSecondRepo();
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      // The fixture page outlives each test, overlay and all; hand it this config.
      await attacher.broadcastConfig();
      await sleep(150);
      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);
      await sleep(150);

      const rows = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-linked-name')).map(n => n.textContent))`,
      );
      expect(JSON.parse(String(rows))).toEqual(["repo", "api"]);
      // Adding, not replacing, is what the box is for now.
      expect(await evaluate(session, `Array.from(${UI}.querySelectorAll('.sq-panel-actions button')).map(b => b.textContent).join(',')`))
        .toBe("Cancel,Add");

      await evaluate(
        session,
        `Array.from(${UI}.querySelectorAll('.sq-linked-row')).find(r => r.textContent.includes('api')).querySelector('.sq-linked-x').click()`,
      );

      let label = "";
      const deadline = Date.now() + 10_000;
      while (label !== "repo" && Date.now() < deadline) {
        await sleep(200);
        label = String(
          (await evaluate(session, `${UI}.querySelector('.sq-channel .sq-channel-label').textContent`)) ?? "",
        );
      }
      expect(label).toBe("repo");

      const stored = JSON.parse(await readFile(join(configHome, "config.json"), "utf8"));
      expect(stored.channels["eng-alerts"].map((l: { repoPath: string }) => l.repoPath)).toEqual([repoPath]);
      expect(stored.channels["eng-alerts"].some((l: { repoPath: string }) => l.repoPath === apiPath)).toBe(false);

      // The panel stays open on what is left.
      const left = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-linked-name')).map(n => n.textContent))`,
      );
      expect(JSON.parse(String(left))).toEqual(["repo"]);
    } finally {
      await evaluate(session, `${UI}.querySelector('.sq-panel-actions button')?.click()`);
      attacher.stop();
      session.close();
    }
  }, 30_000);

  /*
   * `sidequest start` normally runs before Slack has finished opening a
   * workspace, so the first sweep finding nothing is ordinary rather than
   * fatal: the daemon has to still be polling when the window shows up.
   */
  it("attaches to a window that only appears later", async () => {
    const attacher = new Attacher({ cdpPort: PORT, targetUrlPattern: "late-window" });
    await attacher.start();
    expect(attacher.attachedCount).toBe(0);
    expect(attacher.lastSweep.matched).toBe(0);
    expect(attacher.lastSweep.targets).toBeGreaterThan(0);

    const browserWs = (await devtoolsVersion(PORT)).webSocketDebuggerUrl;
    const browser = new CdpSession(browserWs);
    await browser.connect();
    let targetId = "";

    try {
      const created = await browser.send("Target.createTarget", {
        url: `http://127.0.0.1:${HTTP_PORT}/late-window`,
      });
      targetId = String(created.targetId);

      const deadline = Date.now() + 25_000;
      while (attacher.attachedCount === 0 && Date.now() < deadline) await sleep(250);
      expect(attacher.attachedCount).toBe(1);

      // Attached is not the claim worth making on its own — the overlay has to
      // have landed in that window.
      const page = (await listTargets(PORT)).find((t) => t.id === targetId);
      const session = new CdpSession(page!.webSocketDebuggerUrl!);
      await session.connect();
      await session.send("Runtime.enable");
      try {
        let drawn = false;
        while (!drawn && Date.now() < deadline) {
          drawn = (await evaluate(session, "!!document.getElementById('sidequest-layer')")) === true;
          if (!drawn) await sleep(200);
        }
        expect(drawn).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      // Leave the endpoint as it was found: the other tests pick their page by
      // URL, and a second one answering to 127.0.0.1 would confuse them.
      if (targetId) await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
      browser.close();
      attacher.stop();
    }
  }, 60_000);
});
