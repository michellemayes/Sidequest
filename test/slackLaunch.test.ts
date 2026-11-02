import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWithPort, type LaunchDeps, type StartOutcome } from "../src/cdp/launch.js";
import { ensureSidequestProfile, sidequestSlackProfile } from "../src/cdp/slackProfile.js";

const REFUSAL = "Refusing to launch: --remote-debugging-port is not allowed against the default profile\n";

/** A Slack that answers each start with the next outcome, recording which profile it was given. */
function fakeSlack(outcomes: StartOutcome[], existing?: string): LaunchDeps & { starts: (string | undefined)[]; created: number } {
  const deps = {
    starts: [] as (string | undefined)[],
    created: 0,
    existingProfile: () => existing,
    async createProfile() {
      deps.created += 1;
      return "/profiles/Slack-Sidequest";
    },
    async start(_port: number, profile: string | undefined) {
      deps.starts.push(profile);
      return outcomes.shift() ?? { kind: "timed-out", output: "" };
    },
  };
  return deps;
}

describe("startWithPort", () => {
  /*
   * The reported bug: Restart Slack quit Slack and started it with the port,
   * Slack 4.53 refused the port on its default profile and quit, and the app
   * waited 45 seconds for a port that never opened.
   */
  it("starts Slack on Sidequest's profile when it refuses the port on its default one", async () => {
    const slack = fakeSlack([{ kind: "exited", output: REFUSAL }, { kind: "listening" }]);
    await expect(startWithPort(9222, slack)).resolves.toBe("/profiles/Slack-Sidequest");
    expect(slack.starts).toEqual([undefined, "/profiles/Slack-Sidequest"]);
    expect(slack.created).toBe(1);
  });

  it("goes straight to Sidequest's profile once it exists", async () => {
    const slack = fakeSlack([{ kind: "listening" }], "/profiles/Slack-Sidequest");
    await startWithPort(9222, slack);
    expect(slack.starts).toEqual(["/profiles/Slack-Sidequest"]);
    expect(slack.created).toBe(0);
  });

  it("leaves an older Slack on its default profile", async () => {
    const slack = fakeSlack([{ kind: "listening" }]);
    await expect(startWithPort(9222, slack)).resolves.toBeUndefined();
    expect(slack.created).toBe(0);
  });

  it("says what Slack said when it quits on Sidequest's profile too", async () => {
    const slack = fakeSlack([
      { kind: "exited", output: REFUSAL },
      { kind: "exited", output: "[ERROR] Something else went wrong\n" },
    ]);
    await expect(startWithPort(9222, slack)).rejects.toThrow("Slack quit without opening 127.0.0.1:9222: [ERROR] Something else went wrong");
  });

  it("does not make a profile for a Slack that is just slow", async () => {
    const slack = fakeSlack([{ kind: "timed-out", output: "" }]);
    await expect(startWithPort(9222, slack)).rejects.toThrow("Slack started but nothing is listening on 127.0.0.1:9222.");
    expect(slack.created).toBe(0);
  });
});

describe("ensureSidequestProfile", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sidequest-profile-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seed(base: string): Promise<void> {
    await mkdir(join(base, "Local Storage", "leveldb"), { recursive: true });
    await writeFile(join(base, "Cookies"), "signed-in");
    await writeFile(join(base, "Local Storage", "leveldb", "000003.log"), "workspaces");
    await mkdir(join(base, "Cache", "Cache_Data"), { recursive: true });
    await writeFile(join(base, "Cache", "Cache_Data", "blob"), "x");
    await symlink("host-123", join(base, "SingletonLock"));
  }

  it("copies the default profile, without its caches or lock, so you stay signed in", async () => {
    const base = join(home, "Library", "Application Support", "Slack");
    await seed(base);
    const made = await ensureSidequestProfile(home);
    expect(made).toBe(join(home, "Library", "Application Support", "Slack-Sidequest"));
    expect((await readdir(made)).sort()).toEqual(["Cookies", "Local Storage"]);
    expect(existsSync(join(made, "Local Storage", "leveldb", "000003.log"))).toBe(true);
  });

  it("puts the App Store build's profile inside its container", async () => {
    const container = join(home, "Library", "Containers", "com.tinyspeck.slackmacgap", "Data", "Library", "Application Support");
    await seed(join(container, "Slack"));
    expect(sidequestSlackProfile(home)).toBe(join(container, "Slack-Sidequest"));
    expect(existsSync(join(await ensureSidequestProfile(home), "Cookies"))).toBe(true);
  });

  it("keeps a profile it already made", async () => {
    const base = join(home, "Library", "Application Support", "Slack");
    await seed(base);
    const made = await ensureSidequestProfile(home);
    await writeFile(join(made, "Cookies"), "newer");
    await writeFile(join(base, "Cookies"), "older");
    await ensureSidequestProfile(home);
    expect(await readFile(join(made, "Cookies"), "utf8")).toBe("newer");
  });
});
