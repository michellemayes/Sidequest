import { afterAll, beforeAll, afterEach, beforeEach, describe } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { CdpSession, listTargets, devtoolsVersion, type CdpTarget } from "../../src/cdp/client.js";
import { Attacher } from "../../src/cdp/attacher.js";
import { sleep } from "../../src/util/async.js";
import { inspectRepo } from "../../src/git/repo.js";
import { createWorktree } from "../../src/git/worktree.js";
import { recordSession } from "../../src/session/history.js";

export const exec = promisify(execFile);
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

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
export const GEOMETRY = `JSON.stringify({
  body: document.body.scrollHeight,
  list: document.getElementById('list').scrollHeight,
  sidebar: document.getElementById('sidebar').scrollHeight,
  rows: Array.from(document.querySelectorAll('[data-qa="virtual-list-item"]')).map((row) => {
    const rect = row.getBoundingClientRect();
    return [Math.round(rect.top), Math.round(rect.height), getComputedStyle(row).position];
  }),
})`;
// Overridable so two runs on one machine (say, two checkouts) do not collide.
const BASE_PORT = Number(process.env.SIDEQUEST_E2E_PORT) || 9333;
/** This file's browser's DevTools port, and the fixture server's beside it. */
export let PORT = BASE_PORT;
export let HTTP_PORT = BASE_PORT + 1;

let chrome: ChildProcess | null = null;
let server: Server | null = null;
let profileDir = "";
/** The fixture page's layout before anything was injected; see GEOMETRY. */
export let baseline = "";
/** A tiny PNG's first bytes: enough to be a file, and to check it arrived intact. */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** Bodies of what the overlay posted to the fixture's stand-in for Slack's API. */
export const posts: string[] = [];
let dropNextPost = false;
/** Take the next post, then lose its answer on the way back, as a flaky network can. */
export function dropNextPostAnswer(): void {
  dropNextPost = true;
}
/**
 * Stand-ins for more of Slack's API, by method, set by the test that needs
 * them. Each gets the raw form body and returns the JSON to answer with.
 * Consulted before the built-in ones above.
 */
export const apiHandlers = new Map<string, (body: string) => unknown>();
/** One field of a multipart form body. */
export const formField = (body: string, name: string) =>
  body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^]*?)\\r\\n--`))?.[1];

/**
 * These exercise the real CDP path — a real browser, the real injected
 * overlay, the real Attacher — because that plumbing is the part unit tests
 * cannot speak for. Chromium stands in for Slack's Electron renderer, which is
 * the same engine driven the same way.
 */
export const describeIfChrome = CHROME ? describe : describe.skip;

/** The test's own temp dir, its git repo (linked to #eng-alerts) and its SIDEQUEST_HOME. */
export let root = "";
export let repoPath = "";
export let configHome = "";

/**
 * A headless Chromium on the fixture page for the calling test file, and a
 * fresh repo and config for each of its tests. Each file passes its own
 * `slot` so that files running side by side get browsers of their own.
 */
export function useOverlayBrowser(slot: number): void {
  PORT = BASE_PORT + slot * 2;
  HTTP_PORT = PORT + 1;

  beforeAll(async () => {
    const fixture = await readFile(join(HERE, "fixture.html"), "utf8");
    server = createServer((req, res) => {
      // As Slack's API does: a wildcard, which a browser does not honour for
      // a request sent with cookies from another origin.
      if (req.url?.startsWith("/api/")) res.setHeader("access-control-allow-origin", "*");
      const custom = req.method === "POST" ? apiHandlers.get(req.url?.slice("/api/".length) ?? "") : undefined;
      if (custom) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(custom(body)));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/chat.postMessage") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          posts.push(body);
          if (dropNextPost) {
            // Cut off mid-answer. Dropping the socket before any answer would
            // have Chromium quietly resend the post on a fresh connection.
            dropNextPost = false;
            res.writeHead(200, { "content-type": "application/json", "content-length": "64" });
            res.write("{");
            setTimeout(() => req.socket.destroy(), 50);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/conversations.replies") {
        req.resume();
        req.on("end", () => {
          const ts = (Date.now() / 1000).toFixed(6);
          // Handed back as Slack does: emoji as shortcodes, quotes curled,
          // and no client_msg_id, so the text alone has to be recognised.
          const messages = posts.map((body) => ({
            ts,
            text: formField(body, "text")?.replace(/\r\n/g, "\n").replace(/🤖/g, ":robot_face:").replace(/'/g, "\u2019"),
          }));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, messages }));
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
      // Stands in for Slack's file host, serving a message's attachments.
      if (req.method === "GET" && req.url?.startsWith("/files/")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
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

    // Measure the untouched page: nothing has attached to it yet. Listing gets
    // the same patience as the port above: these suites run in parallel, each
    // with its own Chromium, and a loaded machine can take longer than the
    // three seconds listTargets allows a single call.
    let page: CdpTarget | undefined;
    for (;;) {
      page = await listTargets(PORT)
        .then((targets) => targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1")))
        .catch(() => undefined);
      if (page?.webSocketDebuggerUrl) break;
      if (Date.now() > deadline) throw new Error("no fixture page target");
      await sleep(250);
    }
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
    apiHandlers.clear();
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
}

export async function attachAndEval(
  options: { watchIntervalMs?: number | false; syncIntervalMs?: number } = {},
): Promise<{ attacher: Attacher; session: CdpSession }> {
  const attacher = new Attacher({
    cdpPort: PORT,
    targetUrlPattern: "127\\.0\\.0\\.1",
    watchIntervalMs: options.watchIntervalMs ?? false,
    syncIntervalMs: options.syncIntervalMs,
  });
  await attacher.start();

  const targets = await listTargets(PORT);
  const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
  if (!page?.webSocketDebuggerUrl) throw new Error("no fixture page target");

  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.connect();
  await session.send("Runtime.enable");
  return { attacher, session };
}

export async function evaluate(
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

export const UI = "document.getElementById('sidequest-layer').shadowRoot";

/** What matches a selector in the chips drawn inside messages, each in a shadow root of its own. */
export const INLINE =
  "((sel) => Array.from(document.querySelectorAll('sidequest-inline')).flatMap((h) => Array.from(h.shadowRoot.querySelectorAll(sel))))";

/** The overlay only draws on hover, so the tests move a pointer first. */
export async function hover(session: CdpSession, id: string | null): Promise<void> {
  await evaluate(session, `window.__hover(${id ? `'${id}'` : "null"})`);
  // One frame for the placement pass, plus a little slack for CI.
  await sleep(150);
}

/**
 * Whether any shown overlay element matching `selector` covers the text of
 * a row — the words someone wrote, not just the row's box.
 */
export function coversText(selector: string, rowId: string, from = `((sel) => ${UI}.querySelectorAll(sel))`): string {
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
    return Array.from(${from}('${selector}'))
      .filter((el) => !el.classList.contains('sq-off'))
      .map((el) => el.getBoundingClientRect())
      .some((a) => ink.some((b) =>
        a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
  })()`;
}

export function shown(selector: string): string {
  return `(() => {
    const el = ${UI}.querySelector('${selector}');
    return !!el && !el.classList.contains('sq-off');
  })()`;
}

/** Wait for the line on a message to stop saying it is starting. */
export async function settledResult(session: CdpSession): Promise<string> {
  let text = "";
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    text = String(
      (await evaluate(
        session,
        `${INLINE}('.sq-result:not(.sq-off):not([data-kind="busy"]) .sq-result-text')[0]?.textContent || ''`,
      )) ?? "",
    );
    if (text) break;
    await sleep(300);
  }
  return text;
}

export async function press(session: CdpSession, key: string, code: string, keyCode: number): Promise<void> {
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

/** The worktree a session made, found by a fragment of its branch. */
export async function worktreeFor(fragment: string): Promise<string> {
  const worktrees = await exec("git", ["worktree", "list"], { cwd: repoPath });
  const line = worktrees.stdout.split("\n").find((l) => l.includes(fragment));
  return line?.split(/\s+/)[0] ?? "";
}

/** The text of the mark drawn on a row, or '' when there is none. */
export function markOn(rowId: string): string {
  return `(() => {
    const marks = ${INLINE}('.sq-mark').filter((m) => !m.classList.contains('sq-off'));
    const row = document.getElementById('${rowId}').getBoundingClientRect();
    const hit = marks.find((m) => {
      const r = m.getBoundingClientRect();
      return r.top >= row.top - 1 && r.bottom <= row.bottom + 1;
    });
    return hit ? hit.textContent : '';
  })()`;
}

export async function waitFor(session: CdpSession, expression: string, ok: (v: string) => boolean, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  let value = "";
  while (Date.now() < deadline) {
    value = String(await evaluate(session, expression));
    if (ok(value)) return value;
    await sleep(200);
  }
  return value;
}

/** A second checkout next to the test repo, linked to #eng-alerts after it. */
export async function linkSecondRepo(): Promise<string> {
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

/** Poll the page until `expression` is truthy, and return what it last gave. */
export async function until(session: CdpSession, expression: string, ms = 10_000): Promise<unknown> {
  const deadline = Date.now() + ms;
  let value: unknown;
  for (;;) {
    value = await evaluate(session, expression);
    if (value || Date.now() > deadline) return value;
    await sleep(150);
  }
}

/** A session made the way the daemon makes one, without going through Warp. */
export async function madeSession(branch: string, minutesAgo: number): Promise<string> {
  const repo = await inspectRepo(repoPath);
  const wt = await createWorktree({
    repo,
    branch,
    baseBranch: "main",
    worktreesRoot: join(root, "worktrees"),
    fetch: false,
  });
  await recordSession({
    ts: "",
    channel: "eng-alerts",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: wt.branch,
    worktreePath: wt.path,
    repoPath: repo.root,
    repoLabel: "repo",
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  return wt.path;
}

/** ⌃⇧S: Control (2) and Shift (8) held. */
export async function openSessionsByKey(session: CdpSession): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await session.send("Input.dispatchKeyEvent", {
      type, key: "S", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 | 8,
    });
  }
}
