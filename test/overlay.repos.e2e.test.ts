import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import {
  describeIfChrome,
  attachAndEval,
  configHome,
  evaluate,
  exec,
  hover,
  INLINE,
  linkSecondRepo,
  press,
  repoPath,
  settledResult,
  UI,
  useOverlayBrowser,
} from "./support/overlay.js";

describeIfChrome("overlay over CDP: linking repos", () => {
  useOverlayBrowser(3);

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

  it("asks which repo in a channel with several, and starts the session there", async () => {
    const apiPath = await linkSecondRepo();
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      // The fixture page outlives each test, overlay and all; hand it this config.
      await attacher.broadcastConfig();
      await sleep(150);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);

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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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
});
