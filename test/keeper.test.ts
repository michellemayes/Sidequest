import { describe, expect, it } from "vitest";
import { hasPortFlag, SlackKeeper, type KeeperDeps, type KeeperEvent } from "../src/cdp/keeper.js";

const PORT = 9222;

/** A fake Mac: one Slack process (or none), a port, and a relaunch that records itself. */
function fakeMac(state: {
  slack: { pid: number; args: string } | null;
  portOpen: boolean;
  relaunchFails?: boolean;
}): KeeperDeps & { relaunches: number } {
  const deps = {
    relaunches: 0,
    async slackProcess() {
      return state.slack;
    },
    async portOpen() {
      return state.portOpen;
    },
    async relaunch(port: number) {
      deps.relaunches += 1;
      if (state.relaunchFails) throw new Error("Slack did not quit in time.");
      state.slack = { pid: (state.slack?.pid ?? 0) + 1, args: `/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=${port}` };
      state.portOpen = true;
    },
  };
  return deps;
}

function keeper(deps: KeeperDeps, events: KeeperEvent[] = []): SlackKeeper {
  return new SlackKeeper({ cdpPort: PORT, targetUrlPattern: "app\\.slack\\.com", deps, onEvent: (e) => events.push(e) });
}

describe("SlackKeeper", () => {
  /*
   * The reported bug: quit Slack, reopen it from the Dock, and the overlay
   * never comes back, because the reopened Slack has no DevTools port.
   */
  it("relaunches a Slack reopened without the DevTools port", async () => {
    const mac = fakeMac({ slack: { pid: 100, args: "/Applications/Slack.app/Contents/MacOS/Slack" }, portOpen: false });
    const events: KeeperEvent[] = [];
    expect(await keeper(mac, events).check()).toBe(true);
    expect(mac.relaunches).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["relaunching", "relaunched"]);
  });

  it("leaves Slack alone while it is quit", async () => {
    const mac = fakeMac({ slack: null, portOpen: false });
    expect(await keeper(mac).check()).toBe(false);
    expect(mac.relaunches).toBe(0);
  });

  it("leaves a Slack that is already listening alone", async () => {
    const mac = fakeMac({ slack: { pid: 100, args: "Slack" }, portOpen: true });
    expect(await keeper(mac).check()).toBe(false);
    expect(mac.relaunches).toBe(0);
  });

  it("does not restart a Slack that has the flag and is still starting", async () => {
    const mac = fakeMac({
      slack: { pid: 100, args: `/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=${PORT}` },
      portOpen: false,
    });
    expect(await keeper(mac).check()).toBe(false);
    expect(mac.relaunches).toBe(0);
  });

  it("gives up on a Slack it failed to relaunch, and tries again on a new one", async () => {
    const state = { slack: { pid: 100, args: "Slack" }, portOpen: false, relaunchFails: true };
    const mac = fakeMac(state);
    const k = keeper(mac);
    await k.check();
    await k.check();
    expect(mac.relaunches).toBe(1);

    state.slack = { pid: 200, args: "Slack" };
    await k.check();
    expect(mac.relaunches).toBe(2);
  });
});

describe("hasPortFlag", () => {
  it("matches the flag for this port only", () => {
    expect(hasPortFlag("Slack --remote-debugging-port=9222", 9222)).toBe(true);
    expect(hasPortFlag("Slack --remote-debugging-port=9222 --foo", 9222)).toBe(true);
    expect(hasPortFlag("Slack --remote-debugging-port=92220", 9222)).toBe(false);
    expect(hasPortFlag("Slack --remote-debugging-port=9333", 9222)).toBe(false);
    expect(hasPortFlag("Slack", 9222)).toBe(false);
  });
});
