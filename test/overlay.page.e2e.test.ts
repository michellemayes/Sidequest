import { expect, it } from "vitest";
import { CdpSession, listTargets, devtoolsVersion } from "../src/cdp/client.js";
import { Attacher } from "../src/cdp/attacher.js";
import { sleep } from "../src/util/async.js";
import {
  describeIfChrome,
  attachAndEval,
  baseline,
  coversText,
  evaluate,
  GEOMETRY,
  hover,
  HTTP_PORT,
  INLINE,
  linkSecondRepo,
  PORT,
  press,
  settledResult,
  shown,
  UI,
  waitFor,
  useOverlayBrowser,
} from "./support/overlay.js";

describeIfChrome("overlay over CDP: the page it is drawn on", () => {
  useOverlayBrowser(0);

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

  it("keeps the pill and the line off a message's text, on a line of their own", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);

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
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
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

  it("drops a stale result when the virtual list recycles a row", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);

      // Results from earlier tests are still on screen — this page is never
      // reloaded. Their × dismisses them, which is also how a reader does it.
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      await sleep(150);
      expect(await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)').length`)).toBe(0);

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
          (await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)')[0]?.textContent || ''`)) ?? "",
        );
        if (text && !text.startsWith("Starting")) break;
        await sleep(300);
      }
      expect(text).toContain("investigate/only-on-the-eu-store");

      // Slack recycles the row into a different message.
      await evaluate(session, "window.__recycle('row-2', 'something else entirely', '1757439999.000900')");
      await sleep(800);

      // The old result must not still be sitting under someone else's message.
      const results = await evaluate(session, `${INLINE}('.sq-result:not(.sq-off)').length`);
      expect(results).toBe(0);
    } finally {
      attacher.stop();
      session.close();
    }
  }, 45_000);

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

  it("puts the chip under a message's attachments, over its replies, not beside it", async () => {
    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, `${INLINE}('.sq-result-x').forEach((el) => el.click())`);
      // Slack's own shape: the avatar gutter and the message side by side,
      // the message holding its words, an unfurled card and the replies bar.
      await evaluate(session, `(() => {
        const content = document.querySelector('#row-1 [data-qa="message_content"]');
        const gutter = document.createElement('div');
        gutter.id = 'gutter';
        gutter.style.display = 'flex';
        const avatar = document.createElement('div');
        avatar.style.cssText = 'flex: 0 0 36px; height: 36px';
        content.before(gutter);
        gutter.append(avatar, content);
        content.style.flex = '1 1 auto';
        const card = document.createElement('div');
        card.id = 'card';
        card.style.cssText = 'width: 200px; height: 40px';
        const bar = document.createElement('div');
        bar.className = 'c-message__reply_bar';
        bar.textContent = '2 replies';
        content.append(card, bar);
      })()`);

      await hover(session, "row-1");
      await evaluate(session, `${UI}.querySelector('.sq-launch').click()`);
      await sleep(150);
      await press(session, "2", "Digit2", 50);
      await settledResult(session);

      const spot = await evaluate(
        session,
        `(() => {
           const host = document.querySelector('#row-1 sidequest-inline');
           const line = host.shadowRoot.querySelector('.sq-result').getBoundingClientRect();
           const text = document.querySelector('#row-1 .p-rich_text_section').getBoundingClientRect();
           const card = document.getElementById('card').getBoundingClientRect();
           const bar = document.querySelector('#row-1 .c-message__reply_bar').getBoundingClientRect();
           return JSON.stringify({
             overBar: host.nextElementSibling?.className,
             underCard: line.top >= card.bottom - 1,
             aboveBar: line.bottom <= bar.top + 1,
             alignedWithText: Math.abs(line.left - text.left) <= 1,
           });
         })()`,
      );
      expect(JSON.parse(String(spot))).toEqual({
        overBar: "c-message__reply_bar",
        underCard: true,
        aboveBar: true,
        alignedWithText: true,
      });

      // Without a replies bar, the chip still ends the message's own column.
      await evaluate(session, `document.querySelector('#row-1 .c-message__reply_bar').remove()`);
      const end = await waitFor(
        session,
        `document.querySelector('#row-1 [data-qa="message_content"]').lastElementChild?.localName || ''`,
        (v) => v === "sidequest-inline",
      );
      expect(end).toBe("sidequest-inline");
    } finally {
      await evaluate(session, `(() => {
        const gutter = document.getElementById('gutter');
        if (!gutter) return;
        const content = gutter.querySelector('[data-qa="message_content"]');
        content.style.flex = '';
        content.querySelectorAll('#card, .c-message__reply_bar').forEach((el) => el.remove());
        gutter.replaceWith(content);
      })()`).catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);

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

  /*
   * The overlay's script is registered once, at attach, carrying the config
   * of that moment. A window reloaded later has to come back with the config
   * as it is now, not as it was then.
   */
  it("hands a reloaded window the config as it is now", async () => {
    const attacher = new Attacher({ cdpPort: PORT, targetUrlPattern: "reload-window", watchIntervalMs: false });
    const browser = new CdpSession((await devtoolsVersion(PORT)).webSocketDebuggerUrl);
    await browser.connect();
    let targetId = "";
    let session: CdpSession | null = null;
    try {
      const created = await browser.send("Target.createTarget", {
        url: `http://127.0.0.1:${HTTP_PORT}/reload-window`,
      });
      targetId = String(created.targetId);
      const deadline = Date.now() + 25_000;
      await attacher.start();
      while (attacher.attachedCount === 0 && Date.now() < deadline) {
        await sleep(250);
        await attacher.sweepNow();
      }
      expect(attacher.attachedCount).toBe(1);

      const page = (await listTargets(PORT)).find((t) => t.id === targetId);
      session = new CdpSession(page!.webSocketDebuggerUrl!);
      await session.connect();
      await session.send("Runtime.enable");
      const label =
        "(() => { const l = document.getElementById('sidequest-layer'); " +
        "const el = l && l.shadowRoot.querySelector('.sq-channel .sq-channel-label'); " +
        "return el ? el.textContent : ''; })()";
      const until = async (want: string): Promise<string> => {
        let seen = "";
        while (Date.now() < deadline) {
          seen = String(await evaluate(session!, label).catch(() => ""));
          if (seen === want) break;
          await sleep(200);
        }
        return seen;
      };
      expect(await until("repo")).toBe("repo");

      // Linked behind the overlay's back, with no broadcast: only the reload
      // can bring it in.
      await linkSecondRepo();
      await session.send("Page.reload");
      expect(await until("repo +1")).toBe("repo +1");
    } finally {
      session?.close();
      if (targetId) await browser.send("Target.closeTarget", { targetId }).catch(() => undefined);
      browser.close();
      attacher.stop();
    }
  }, 60_000);
});
