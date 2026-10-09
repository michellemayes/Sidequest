import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../src/util/async.js";
import { decodeNote, encodeNote, syncContentSchema } from "../src/config/sync.js";
import {
  apiHandlers,
  attachAndEval,
  configHome,
  describeIfChrome,
  evaluate,
  formField,
  useOverlayBrowser,
} from "./support/overlay.js";

/** Your DM with yourself, as the stand-in for Slack's API keeps it. */
interface Dm {
  messages: Array<{ ts: string; text: string }>;
  pinned: Set<string>;
  calls: string[];
}

function standInSlack(): Dm {
  const dm: Dm = { messages: [], pinned: new Set(), calls: [] };
  let seq = 0;
  const field = (body: string, name: string) => formField(body, name)?.replace(/\r\n/g, "\n") ?? "";
  const on = (method: string, answer: (body: string) => unknown) =>
    apiHandlers.set(method, (body) => {
      dm.calls.push(method);
      return answer(body);
    });
  on("auth.test", () => ({ ok: true, user_id: "U0ME", team_id: "T0SMOKE" }));
  on("conversations.open", (body) =>
    field(body, "users") === "U0ME" ? { ok: true, channel: { id: "D0SELF" } } : { ok: false, error: "user_not_found" },
  );
  on("pins.list", () => ({
    ok: true,
    items: dm.messages.filter((m) => dm.pinned.has(m.ts)).map((message) => ({ type: "message", message })),
  }));
  on("conversations.history", () => ({ ok: true, messages: [...dm.messages].reverse() }));
  on("chat.postMessage", (body) => {
    const ts = `1760000000.${String(++seq).padStart(6, "0")}`;
    dm.messages.push({ ts, text: field(body, "text") });
    return { ok: true, ts };
  });
  on("chat.update", (body) => {
    const message = dm.messages.find((m) => m.ts === field(body, "ts"));
    if (!message) return { ok: false, error: "message_not_found" };
    message.text = field(body, "text");
    return { ok: true, ts: message.ts };
  });
  on("pins.add", (body) => {
    dm.pinned.add(field(body, "timestamp"));
    return { ok: true };
  });
  on("pins.remove", (body) => {
    dm.pinned.delete(field(body, "timestamp"));
    return { ok: true };
  });
  return dm;
}

async function waitFor<T>(check: () => T | Promise<T>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await sleep(200);
  }
}

describeIfChrome("overlay over CDP: settings sync", () => {
  useOverlayBrowser(5);

  it("keeps the settings in a pinned note in your DM with yourself, both ways", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.settings.sync = true;
    await writeFile(file, JSON.stringify(config));
    const dm = standInSlack();

    const { attacher, session } = await attachAndEval({ syncIntervalMs: 1000 });
    try {
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
      }))`);

      // This computer's settings go up, pinned.
      const first = await waitFor(() => dm.messages[0]);
      expect(first).toBeTruthy();
      // Pinning is a second call, so it lands just after the message itself.
      expect(await waitFor(() => dm.pinned.has(first!.ts))).toBe(true);
      const note = decodeNote(first!.text);
      expect(note.content.channels["eng-alerts"]).toMatchObject([{ name: "repo", remote: "" }]);

      // Another computer turns thread replies on and adds a prompt.
      const theirs = syncContentSchema.parse({
        ...note.content,
        settings: { ...note.content.settings, autoReply: true },
        prompts: { "write-test": { label: "Write a test", template: "Write a test for {{text}}" } },
      });
      first!.text = encodeNote(theirs, new Date(), "other-laptop");
      const pulled = await waitFor(async () => {
        const now = JSON.parse(await readFile(file, "utf8"));
        return now.settings.autoReply === true ? now : null;
      });
      expect(pulled.prompts["write-test"].label).toBe("Write a test");

      // A change made here goes back up, into the same note.
      const updatesBefore = dm.calls.filter((c) => c === "chat.update").length;
      pulled.settings.postResults = "off";
      await writeFile(file, JSON.stringify(pulled));
      await waitFor(() => dm.calls.filter((c) => c === "chat.update").length > updatesBefore);
      expect(dm.messages).toHaveLength(1);
      const after = decodeNote(dm.messages[0]!.text).content;
      expect(after.settings.postResults).toBe("off");
      expect(after.settings.autoReply).toBe(true);
      expect(after.prompts["write-test"]?.label).toBe("Write a test");
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 60_000);

  it("posts a new note when the old one can no longer be edited, and unpins the old", async () => {
    const file = join(configHome, "config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.settings.sync = true;
    await writeFile(file, JSON.stringify(config));
    const dm = standInSlack();
    // An old note from before, which the workspace will not let be edited any more.
    dm.messages.push({ ts: "1700000000.000001", text: encodeNote(syncContentSchema.parse({}), new Date(), "old") });
    dm.pinned.add("1700000000.000001");
    apiHandlers.set("chat.update", () => ({ ok: false, error: "edit_window_closed" }));

    const { attacher, session } = await attachAndEval({ syncIntervalMs: 1000 });
    try {
      await evaluate(session, `localStorage.setItem('localConfig_v2', JSON.stringify({
        teams: { T0SMOKE: { url: location.origin + '/', token: 'xoxc-test' } },
      }))`);
      const fresh = await waitFor(() => dm.messages[1]);
      expect(fresh).toBeTruthy();
      await waitFor(() => !dm.pinned.has("1700000000.000001"));
      expect([...dm.pinned]).toEqual([fresh!.ts]);
      expect(decodeNote(fresh!.text).content.channels["eng-alerts"]).toHaveLength(1);
    } finally {
      await evaluate(session, "localStorage.removeItem('localConfig_v2')").catch(() => undefined);
      attacher.stop();
      session.close();
    }
  }, 60_000);
});
