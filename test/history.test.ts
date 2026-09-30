import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeStats,
  loadHistory,
  recordSession,
  type HistoryEntry,
} from "../src/session/history.js";
import { pageConfig } from "../src/config/pageConfig.js";
import { configSchema } from "../src/config/schema.js";

const NOW = new Date(2026, 8, 30, 15, 0, 0);

function entry(daysAgo: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  const at = new Date(NOW);
  at.setDate(at.getDate() - daysAgo);
  return {
    ts: `17574300${String(daysAgo).padStart(2, "0")}.000100`,
    channel: "eng-alerts",
    promptKey: "fix",
    promptLabel: "Fix",
    branch: `fix/thing-${daysAgo}`,
    worktreePath: `/tmp/wt-${daysAgo}`,
    repoPath: "/tmp/repo",
    repoLabel: "repo",
    createdAt: at.toISOString(),
    ...extra,
  };
}

describe("computeStats", () => {
  it("counts nothing for an empty history", () => {
    const s = computeStats([], NOW);
    expect(s).toMatchObject({ total: 0, today: 0, streak: 0, bestStreak: 0, milestone: null });
  });

  it("counts a streak of consecutive days ending today", () => {
    const s = computeStats([entry(3), entry(2), entry(1), entry(0)], NOW);
    expect(s.streak).toBe(4);
    expect(s.today).toBe(1);
    expect(s.firstToday).toBe(true);
  });

  it("keeps yesterday's streak alive before today's first session", () => {
    const s = computeStats([entry(2), entry(1)], NOW);
    expect(s.streak).toBe(2);
    expect(s.today).toBe(0);
  });

  it("breaks the streak on a missed day, but remembers the best one", () => {
    const s = computeStats([entry(6), entry(5), entry(4), entry(2), entry(0)], NOW);
    expect(s.streak).toBe(1);
    expect(s.bestStreak).toBe(3);
  });

  it("flags a milestone only when the total lands on one", () => {
    expect(computeStats([entry(0)], NOW).milestone).toBe(1);
    expect(computeStats([entry(1), entry(0)], NOW).milestone).toBeNull();
    const ten = Array.from({ length: 10 }, () => entry(0));
    expect(computeStats(ten, NOW).milestone).toBe(10);
  });

  it("tallies by prompt and by channel", () => {
    const s = computeStats(
      [entry(0), entry(0, { promptKey: "review", channel: "web" }), entry(1)],
      NOW,
    );
    expect(s.byPrompt).toEqual({ fix: 2, review: 1 });
    expect(s.byChannel).toEqual({ "eng-alerts": 2, web: 1 });
    expect(s.today).toBe(2);
    expect(s.firstToday).toBe(false);
  });
});

describe("history store", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sidequest-history-"));
    process.env.SIDEQUEST_HOME = home;
  });

  afterEach(async () => {
    delete process.env.SIDEQUEST_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("keeps every session when several are recorded at once", async () => {
    await Promise.all([entry(0), entry(1), entry(2), entry(3)].map((e) => recordSession(e)));
    const history = await loadHistory();
    expect(history.map((h) => h.branch).sort()).toEqual([
      "fix/thing-0",
      "fix/thing-1",
      "fix/thing-2",
      "fix/thing-3",
    ]);
  });

  it("treats a corrupt file as an empty history rather than failing", async () => {
    await writeFile(join(home, "history.json"), "{ not json");
    expect(await loadHistory()).toEqual([]);
  });

  it("hands the page each message's sessions, keyed by ts", () => {
    const config = configSchema.parse({});
    const page = pageConfig(config, [entry(1, { ts: "1.1" }), entry(0, { ts: "1.1", promptLabel: "Review" })]);
    expect(page.sessions["1.1"]!.map((s) => s.label)).toEqual(["Fix", "Review"]);
    expect(page.stats.total).toBe(2);
  });
});
