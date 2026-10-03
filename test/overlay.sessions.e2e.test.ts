import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import {
  describeIfChrome,
  attachAndEval,
  evaluate,
  madeSession,
  openSessionsByKey,
  press,
  UI,
  until,
  useOverlayBrowser,
} from "./support/overlay.js";

describeIfChrome("overlay over CDP: the sessions panel", () => {
  useOverlayBrowser(4);

  const sessionRows = `JSON.stringify(Array.from(${UI}.querySelectorAll('.sq-session')).map((row) => [
    row.querySelector('.sq-session-branch')?.textContent || '',
    Array.from(row.querySelectorAll('.sq-chip')).map((c) => c.textContent).join(','),
  ]))`;

  it("lists sessions in a panel of their own, and removes one only as far as it is told", async () => {
    const donePath = await madeSession("fix/done-already", 120);
    const wipPath = await madeSession("fix/still-going", 3);

    const { attacher, session } = await attachAndEval();
    try {
      await sleep(600);
      await evaluate(session, "window.__shortcuts.length = 0");

      // ⌃⇧S from anywhere opens it, and Slack never sees the chord.
      await openSessionsByKey(session);
      expect(await evaluate(session, "JSON.stringify(window.__shortcuts)")).toBe("[]");
      await until(session, `${UI}.querySelectorAll('.sq-session').length === 2`);

      // Newest first, each with what git says about it.
      expect(JSON.parse(String(await evaluate(session, sessionRows)))).toEqual([
        ["fix/still-going", "no commits"],
        ["fix/done-already", "no commits"],
      ]);
      const meta = await evaluate(session, `${UI}.querySelector('.sq-session-meta').textContent`);
      expect(meta).toBe("Fix · repo · #eng-alerts");
      expect(await evaluate(session, `${UI}.querySelector('.sq-session .sq-sub').textContent`)).toBe("3m");

      // It hangs off the channel pill, like the repo panel.
      const placed = await evaluate(session, `(() => {
        const panel = ${UI}.querySelector('.sq-sessions').getBoundingClientRect();
        const pill = ${UI}.querySelector('.sq-channel').getBoundingClientRect();
        return panel.top >= pill.bottom && Math.abs(panel.left - pill.left) <= 1;
      })()`);
      expect(placed).toBe(true);

      // A row reopens its session, named by its worktree, and the panel gets
      // out of the way. (Nothing can open Warp here, so the toast may carry
      // the launcher's complaint — but never that the session is gone.)
      await evaluate(session, `${UI}.querySelector('.sq-session-open').click()`);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-sessions')`)).toBe(false);
      // (An earlier test's toast can still be up; wait for this one's.)
      const reopened = String(await until(
        session,
        `[${UI}.querySelector('.sq-toast')?.textContent || ''].find((t) => t.includes('still-going')) || ''`,
      ));
      expect(reopened).not.toMatch(/gone/);
      expect(reopened).toMatch(/Back in fix\/still-going|fix-still-going to Warp/);
      await openSessionsByKey(session);
      await until(session, `${UI}.querySelectorAll('.sq-session').length === 2`);

      // Removing asks first, in the row; Enter answers a plain removal.
      await press(session, "ArrowDown", "ArrowDown", 40);
      await press(session, "ArrowDown", "ArrowDown", 40);
      await press(session, "Delete", "Delete", 46);
      expect(await until(session, `${UI}.querySelector('.sq-confirm-remove')?.textContent`)).toBe("Remove");
      await press(session, "Enter", "Enter", 13);
      await until(session, `${UI}.querySelectorAll('.sq-session').length === 1`);
      expect(existsSync(donePath)).toBe(false);
      expect(await evaluate(session, `${UI}.querySelector('.sq-toast-title').textContent`))
        .toBe("Removed fix/done-already");

      // Work that appeared after the list was drawn is still caught: the
      // daemon refuses, and the row asks again, now about discarding it.
      await writeFile(join(wipPath, "notes.txt"), "half done\n");
      await evaluate(session, `${UI}.querySelector('.sq-session-x').click()`);
      await until(session, `${UI}.querySelector('.sq-confirm-remove')`);
      await evaluate(session, `${UI}.querySelector('.sq-confirm-remove').click()`);
      expect(await until(session, `${UI}.querySelector('.sq-session[data-confirm="force"] .sq-confirm-remove')?.textContent`))
        .toBe("Discard and remove");
      expect(String(await evaluate(session, `${UI}.querySelector('.sq-session-confirm').textContent`)))
        .toContain("1 uncommitted change");
      expect(existsSync(join(wipPath, "notes.txt"))).toBe(true);

      // A key pressed out of habit cannot discard work; only the button can.
      await press(session, "Enter", "Enter", 13);
      await sleep(500);
      expect(existsSync(join(wipPath, "notes.txt"))).toBe(true);
      await evaluate(session, `${UI}.querySelector('.sq-confirm-remove').click()`);
      await until(session, `${UI}.querySelectorAll('.sq-session').length === 0`);
      expect(existsSync(wipPath)).toBe(false);
      expect(String(await evaluate(session, `${UI}.querySelector('.sq-sessions .sq-panel-note').textContent`)))
        .toContain("No sessions");

      // Escape closes it; the repo panel leads back to it.
      await press(session, "Escape", "Escape", 27);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-sessions')`)).toBe(false);
      await evaluate(session, `${UI}.querySelector('.sq-channel').click()`);
      await sleep(100);
      await evaluate(session, `${UI}.querySelector('.sq-to-sessions').click()`);
      await sleep(100);
      expect(await evaluate(session, `!!${UI}.querySelector('.sq-sessions') && !${UI}.querySelector('.sq-panel:not(.sq-sessions)')`))
        .toBe(true);
    } finally {
      await press(session, "Escape", "Escape", 27).catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 45_000);
});
