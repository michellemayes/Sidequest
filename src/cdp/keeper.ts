/**
 * Keeps Slack reachable after the user quits and reopens it.
 *
 * Slack only opens its DevTools port when launched with
 * --remote-debugging-port, and a Slack reopened from the Dock, Spotlight or
 * login items is launched without it. The daemon would sit there polling a
 * closed port and the overlay would never come back. So while the daemon
 * runs, a Slack that shows up without the flag is quit and relaunched with
 * it, straight away, while it is still starting up and has nothing open yet.
 */
import { run } from "../util/exec.js";
import { describeError } from "../util/errors.js";
import { platform } from "../util/platform.js";
import { inspectDebugPort, launchSlack } from "./launch.js";

const CHECK_MS = 1500;

export interface KeeperEvent {
  type: "relaunching" | "relaunched" | "relaunch-error";
  message?: string;
}

/** What the keeper needs from the machine; swapped out in tests. */
export interface KeeperDeps {
  /** Pid and full command line of the running main Slack process, if any. */
  slackProcess(): Promise<{ pid: number; args: string } | null>;
  portOpen(port: number): Promise<boolean>;
  relaunch(port: number): Promise<void>;
}

export class SlackKeeper {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private busy = false;
  /**
   * The Slack process a relaunch last failed on. It is not tried again, so a
   * Slack that refuses the flag is not quit over and over; a new Slack
   * process gets a fresh try.
   */
  private failedPid: number | null = null;

  constructor(
    private readonly options: {
      cdpPort: number;
      targetUrlPattern: string;
      onEvent?: (event: KeeperEvent) => void;
      deps?: KeeperDeps;
      checkMs?: number;
    },
  ) {}

  private get deps(): KeeperDeps {
    return this.options.deps ?? macDeps(this.options.targetUrlPattern);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await this.check();
      if (!this.stopped) {
        // unref'd: the attacher's poll is what keeps the daemon alive.
        this.timer = setTimeout(() => void tick(), this.options.checkMs ?? CHECK_MS);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One look at Slack; true when it was relaunched. Exposed for tests. */
  async check(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const { cdpPort } = this.options;
      const slack = await this.deps.slackProcess();
      if (!slack) return false;
      // Started with the flag and still coming up, or already listening.
      if (hasPortFlag(slack.args, cdpPort)) return false;
      if (await this.deps.portOpen(cdpPort)) return false;
      if (slack.pid === this.failedPid) return false;

      this.emit({ type: "relaunching" });
      try {
        await this.deps.relaunch(cdpPort);
        this.failedPid = null;
        this.emit({ type: "relaunched" });
        return true;
      } catch (err) {
        this.failedPid = slack.pid;
        this.emit({ type: "relaunch-error", message: describeError(err).message });
        return false;
      }
    } catch (err) {
      this.emit({ type: "relaunch-error", message: describeError(err).message });
      return false;
    } finally {
      this.busy = false;
    }
  }

  private emit(event: KeeperEvent): void {
    this.options.onEvent?.(event);
  }
}

/** True when a command line asks for DevTools on this port. */
export function hasPortFlag(args: string, port: number): boolean {
  return new RegExp(`--remote-debugging-port[= ]${port}(\\s|$)`).test(args);
}

function macDeps(targetUrlPattern: string): KeeperDeps {
  return {
    async slackProcess() {
      if (platform() !== "darwin") return null;
      let pid: number;
      try {
        // -x matches the main process only, not "Slack Helper (Renderer)".
        const { stdout } = await run("/usr/bin/pgrep", ["-x", "Slack"], { timeoutMs: 5000 });
        pid = Number(stdout.trim().split(/\s+/)[0]);
      } catch {
        return null;
      }
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try {
        const { stdout } = await run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { timeoutMs: 5000 });
        return { pid, args: stdout.trim() };
      } catch {
        // Gone between the two calls.
        return null;
      }
    },
    async portOpen(port) {
      return (await inspectDebugPort(port)).open;
    },
    async relaunch(port) {
      await launchSlack({ cdpPort: port, force: true, targetUrlPattern });
    },
  };
}
