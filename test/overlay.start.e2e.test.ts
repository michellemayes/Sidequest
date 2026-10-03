import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import {
  describeIfChrome,
  attachAndEval,
  configHome,
  coversText,
  evaluate,
  exec,
  hover,
  INLINE,
  PNG,
  posts,
  press,
  repoPath,
  settledResult,
  UI,
  worktreeFor,
  useOverlayBrowser,
} from "./support/overlay.js";

describeIfChrome("overlay over CDP: starting sessions", () => {
  useOverlayBrowser(1);

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
          (await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)')[0]?.textContent || ''`)) ?? "",
        );
        if (text && !text.startsWith("Starting")) break;
        await sleep(300);
      }

      // The branch name is built from the message text, which came off the DOM.
      expect(text).toContain("fix/checkout-total-is-wrong-for-gift-cards");

      // The result is part of the message it belongs to: one element of the
      // overlay's own right after the message's content, under the words, and
      // the pill keeps clear of it.
      const anchored = await evaluate(
        session,
        `(() => {
           const content = document.querySelector('#row-1 [data-qa="message_content"]');
           const chip = content.nextElementSibling;
           const line = chip.shadowRoot.querySelector('.sq-result').getBoundingClientRect();
           const btn = ${UI}.querySelector('.sq-launch').getBoundingClientRect();
           const text = content.querySelector('.p-rich_text_section').getBoundingClientRect();
           return JSON.stringify({
             inline: chip.localName,
             inRow: document.getElementById('row-1').contains(chip),
             underText: line.top >= text.bottom - 1,
             clearOfButton: line.right <= btn.left - 2 || line.top >= btn.bottom - 1 || line.bottom <= btn.top + 1,
           });
         })()`,
      );
      expect(JSON.parse(String(anchored))).toEqual({
        inline: "sidequest-inline",
        inRow: true,
        underText: true,
        clearOfButton: true,
      });
      expect(await evaluate(session, coversText(".sq-result", "row-1", INLINE))).toBe(false);
      expect(await evaluate(session, coversText(".sq-result", "row-2", INLINE))).toBe(false);
      // The message text read off the row is still only what was written.
      expect(
        await evaluate(session, `document.querySelector('#row-1 [data-qa="message_content"]').innerText.trim()`),
      ).toBe("Checkout total is wrong for gift cards");

      // The answer comes once the terminal opens; an agent that then never
      // starts is said on the same line, after the fact.
      attacher.followAgentCheck(
        text.match(/fix\/[\w-]+/)![0],
        "eng-alerts",
        Promise.resolve("The agent did not start (test)."),
      );
      let amended = "";
      for (let i = 0; i < 30 && !amended.includes("The agent did not start (test)."); i += 1) {
        await sleep(100);
        amended = String(await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)')[0]?.textContent || ''`));
      }
      expect(amended).toContain("fix/checkout-total-is-wrong-for-gift-cards");
      expect(amended).toContain("The agent did not start (test).");
      expect(
        await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)')[0]?.dataset.kind || ''`),
      ).toBe("warn");

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

  it("offers a Linear prompt on a message that links an issue, and works it", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);

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
      expect(await evaluate(session, coversText(".sq-result", "row-3", INLINE))).toBe(false);
      expect(await evaluate(session, coversText(".sq-result", "row-4", INLINE))).toBe(false);

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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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

      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      attacher.stop();
      session.close();
    }
  }, 60_000);

  it("starts a session from the keyboard, celebrates it, and marks the message", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      await sleep(300);
      const mark = await evaluate(session, `(() => {
        const marks = ${INLINE}('.sq-mark').filter((m) => !m.classList.contains('sq-off'));
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

  it("hands the files attached to a message to the agent", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      // Here the fixture's own server plays Slack's file host.
      await evaluate(session, `window.__sidequestSetConfig(JSON.stringify({ fileHosts: '^127\\\\.0\\\\.0\\\\.1$' }))`);
      // A screenshot the way Slack draws one: a thumbnail inside a link to the original.
      await evaluate(session, `(() => {
        const link = document.createElement('a');
        link.href = '/files/T0SMOKE-F0SHOT1234/screen_shot.png';
        const img = document.createElement('img');
        img.src = '/files/files-tmb/T0SMOKE-F0SHOT1234-abc/screen_shot_720.png';
        img.width = 20; img.height = 12;
        link.append(img);
        document.getElementById('row-1').querySelector('[data-qa="message_content"]').append(link);
      })()`);

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "2", "Digit2", 50);
      const line = await settledResult(session);
      expect(line).toContain("with 1 file");

      const worktree = await worktreeFor("fix-checkout");
      const saved = await readFile(join(worktree, ".sidequest", "attachments", "screen_shot.png"));
      expect(saved.equals(PNG)).toBe(true);
      const prompt = await readFile(join(worktree, ".sidequest", "prompt.md"), "utf8");
      expect(prompt).toContain("### Attachments");
      expect(prompt).toContain("- .sidequest/attachments/screen_shot.png (image/png");
      // And the agent is asked to leave a reply for the thread.
      expect(prompt).toContain(".sidequest/result.md");
    } finally {
      await evaluate(session, `document.querySelectorAll('#row-1 a[href^="/files/"]').forEach((a) => a.remove())`).catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("offers prompts of your own from the config, and runs them", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.prompts = {
      review: { hidden: true },
      triage: { label: "Triage", emoji: "bug", template: "Triage this from @{{author}}:\n{{message}}" },
    };
    await writeFile(file, JSON.stringify(config));

    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      const entries = await evaluate(
        session,
        `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).map(b => [b.textContent, b.dataset.key, b.dataset.glyph]))`,
      );
      expect(JSON.parse(String(entries))).toEqual([
        ["Investigate", "1", "🔍"], ["Fix", "2", "🔧"], ["Ask", "3", "💬"], ["Triage", "4", "🐛"],
      ]);

      await press(session, "t", "KeyT", 84);
      expect(await settledResult(session)).toContain("Triage → triage/checkout-total");
      const prompt = await readFile(join(await worktreeFor("triage-checkout"), ".sidequest", "prompt.md"), "utf8");
      expect(prompt).toMatch(/^Triage this from @/);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

  it("works in the message's own channel's repo from Threads, not the page's", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      await hover(session, "row-2");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await evaluate(session, `Array.from(${UI}.querySelectorAll('.sq-menu-prompt')).find(b => b.textContent === 'Ask').click()`);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-ask-input')`)).toBe(true);

      await press(session, "Escape", "Escape", 27);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-menu')`)).toBe(false);
      expect(await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)').length`)).toBe(0);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 30_000);
});
