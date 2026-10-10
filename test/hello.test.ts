import { describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ commit: "old" as string | null }));
vi.mock("../src/update.js", async (original) => ({
  ...(await original<typeof import("../src/update.js")>()),
  builtCommit: async () => built.commit,
}));

const { createAppHandler } = await import("../src/control/app.js");

describe("hello", () => {
  it("reports the build the daemon started on, not the one on disk now", async () => {
    // The app swaps in its update, engine and all, while the old daemon keeps running.
    built.commit = "old";
    const handle = createAppHandler({} as never);
    built.commit = "new";
    const conn = { subscribed: false, takesNotices: false };
    expect(await handle({ id: 1, op: "hello" }, conn)).toMatchObject({ ok: true, build: "old" });
  });
});
