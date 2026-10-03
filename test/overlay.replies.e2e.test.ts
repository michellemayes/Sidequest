import { expect, it } from "vitest";
import { readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import {
  describeIfChrome,
  attachAndEval,
  configHome,
  dropNextPostAnswer,
  evaluate,
  exec,
  formField,
  hover,
  INLINE,
  markOn,
  posts,
  press,
  settledResult,
  UI,
  until,
  waitFor,
  worktreeFor,
  useOverlayBrowser,
} from "./support/overlay.js";

describeIfChrome("overlay over CDP: thread replies", () => {
  useOverlayBrowser(2);

  it("replies in the message's thread, as you, when autoReply is on", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.settings.autoReply = true;
    config.prompts = { review: { reply: "Reviewing this in {{repo}}." } };
    await writeFile(file, JSON.stringify(config));

    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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

  it("follows a session on its message, and offers the agent's reply to post", async () => {
    const { attacher, session } = await attachAndEval({ watchIntervalMs: 300 });
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      // The workspace's own host is another origin than the page, as
      // acme.slack.com is to app.slack.com.
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: 'http://localhost:' + location.port + '/', token: 'xoxc-test' } },
      }))`);

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "1", "Digit1", 49);
      expect(await settledResult(session)).toContain("investigate/checkout-total");
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      // The pointer moves on, as it would, and leaves the mark its corner.
      await hover(session, null);

      expect(await waitFor(session, markOn("row-1"), (t) => t.includes("working"))).toBe("Investigate · working");

      // The agent finishes and leaves its answer, written a moment ago.
      const worktree = await worktreeFor("investigate-checkout");
      const result = join(worktree, ".sidequest", "result.md");
      await writeFile(result, "## Cause\nThe **gift card** is applied twice.\n");
      const past = (Date.now() - 10_000) / 1000;
      await utimes(result, past, past);

      expect(await waitFor(session, markOn("row-1"), (t) => t.includes("reply ready")))
        .toBe("Investigate · answered · reply ready");
      const toastAction = await waitFor(session, `${UI}.querySelector('.sq-toast-action')?.textContent || ''`, Boolean);
      expect(toastAction).toBe("Review");

      // The mark opens the reply to read, in Slack's markup, signed by the agent.
      await evaluate(session, `(() => {
        const mark = ${INLINE}('.sq-mark').find((m) => m.textContent.includes('reply ready'));
        mark.click();
      })()`);
      const signed = "\n\n_🤖 Written by Claude Code, an AI agent, via Sidequest_";
      const draft = await waitFor(session, `${UI}.querySelector('.sq-reply-input')?.value || ''`, Boolean);
      expect(draft).toBe(`*Cause*\nThe *gift card* is applied twice.${signed}`);

      // Closed without posting, it is still a click away from the header.
      await press(session, "Escape", "Escape", 27);
      expect(await waitFor(session, `${UI}.querySelector('.sq-reply-input') ? 'open' : 'closed'`, (v) => v === "closed"))
        .toBe("closed");
      expect(await waitFor(session, `${UI}.querySelector('.sq-channel .sq-reply-count')?.textContent || ''`, Boolean))
        .toBe("💬 1");

      // The agent is asked to change it: the rewrite is news again.
      await writeFile(result, "## Cause\nThe **gift card** is applied twice, in `applyCredits`.\n");
      const later = (Date.now() - 5_000) / 1000;
      await utimes(result, later, later);
      expect(await waitFor(session, `${UI}.querySelector('.sq-toast-title')?.textContent || ''`, (t) => t.includes("updated")))
        .toBe("Investigate updated its reply for the thread");

      // The badge lists every reply waiting, and opens the one picked.
      await evaluate(session, `${UI}.querySelector('.sq-channel .sq-reply-count').click()`);
      expect(await waitFor(session, `${UI}.querySelector('.sq-replies .sq-session-branch')?.textContent || ''`, Boolean))
        .toContain("investigate/checkout-total");

      // The session's own "reply ready" chip opens the reply, not the session.
      await until(session, `!!${UI}.querySelector('.sq-session .sq-chip[data-tone="reply"]')`);
      await evaluate(session, `${UI}.querySelector('.sq-session .sq-chip[data-tone="reply"]').click()`);
      expect(await waitFor(session, `${UI}.querySelector('.sq-reply-input')?.value || ''`, Boolean))
        .toContain("applyCredits");
      await press(session, "Escape", "Escape", 27);
      await until(session, `!${UI}.querySelector('.sq-reply-input')`);

      await evaluate(session, `${UI}.querySelector('.sq-channel .sq-reply-count').click()`);
      await until(session, `!!${UI}.querySelector('.sq-reply-row')`);
      await evaluate(session, `${UI}.querySelector('.sq-reply-row').click()`);
      const redraft = await waitFor(session, `${UI}.querySelector('.sq-reply-input')?.value || ''`, Boolean);
      expect(redraft).toBe(`*Cause*\nThe *gift card* is applied twice, in \`applyCredits\`.${signed}`);
      // The post reaches Slack but its answer is lost on the way back: the
      // thread shows it went out, so it counts as posted, not failed, even
      // though Slack hands the text back with its emoji as a shortcode.
      dropNextPostAnswer();
      await evaluate(session, `(() => {
        const box = ${UI}.querySelector('.sq-reply-input');
        box.value = box.value.replace(/(\\n\\n_.*_)$/, "\\nFix coming, it's small.$1");
        ${UI}.querySelector('.sq-reply .sq-ask-send').click();
      })()`);

      const deadline = Date.now() + 5000;
      while (posts.length === 0 && Date.now() < deadline) await sleep(100);
      expect(posts).toHaveLength(1);
      const field = (name: string) => formField(posts[0]!, name);
      expect(field("thread_ts")).toBe("1757430000.000100");
      // Form encoding sends line breaks as CRLF; Slack reads them the same.
      expect(field("text")?.replace(/\r\n/g, "\n"))
        .toBe(`*Cause*\nThe *gift card* is applied twice, in \`applyCredits\`.\nFix coming, it's small.${signed}`);
      expect(field("client_msg_id")).toMatch(/^[0-9a-f-]{36}$/);

      // Posted once: the mark stops offering it, and history remembers.
      expect(await waitFor(session, markOn("row-1"), (t) => !t.includes("reply ready"))).toBe("Investigate · answered");
      const history = JSON.parse(await readFile(join(configHome, "history.json"), "utf8"));
      expect(history.sessions.at(-1).resultPostedMs).toBeGreaterThan(0);

      // Commits show up as they land.
      await exec("git", ["commit", "--allow-empty", "-m", "fix"], {
        cwd: worktree,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
      });
      expect(await waitFor(session, markOn("row-1"), (t) => t.includes("commit"))).toBe("Investigate · 1 commit");
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 60_000);

  it("posts the agent's reply by itself when postResults is auto, once", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.settings.postResults = "auto";
    await writeFile(file, JSON.stringify(config));

    const { attacher, session } = await attachAndEval({ watchIntervalMs: 300 });
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
      }))`);
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "1", "Digit1", 49);
      expect(await settledResult(session)).toContain("investigate/checkout-total");

      const worktree = await worktreeFor("investigate-checkout");
      const prompt = await readFile(join(worktree, ".sidequest", "prompt.md"), "utf8");
      expect(prompt).toContain("as soon as you write it");
      // Lose the first word back to the daemon that the reply went out: the
      // post itself landed, so nothing should call it a failure.
      await evaluate(session, `(() => {
        const real = window.__sidequestAsk;
        let dropped = false;
        window.__sidequestAsk = (json) => {
          if (!dropped && JSON.parse(json).op === 'result-posted') {
            dropped = true;
            throw new Error('binding went away');
          }
          return real(json);
        };
      })()`);
      const result = join(worktree, ".sidequest", "result.md");
      await writeFile(result, "It is the rounding in `total()`.\n");
      const past = (Date.now() - 10_000) / 1000;
      await utimes(result, past, past);

      const deadline = Date.now() + 10_000;
      while (posts.length === 0 && Date.now() < deadline) await sleep(100);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("It is the rounding in `total()`.");
      expect(posts[0]).toContain("Written by Claude Code, an AI agent");
      // No second post for the same reply, however many passes follow.
      await sleep(3000);
      expect(posts).toHaveLength(1);
      const toasts = String(await evaluate(session,
        `Array.from(${UI}.querySelectorAll('.sq-toast-title'), (el) => el.textContent).join('|')`));
      expect(toasts).toContain("Replied in the thread");
      expect(toasts).not.toContain("Could not");
      const history = JSON.parse(await readFile(join(configHome, "history.json"), "utf8"));
      expect(history.sessions.at(-1).resultPostedMs).toBeGreaterThan(0);
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);
});
