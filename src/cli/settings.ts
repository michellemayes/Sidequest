import { AGENT_DEFINITIONS, describeAgent, describeHeadless, resolveAgent } from "../agents/agents.js";
import { linkLabel } from "../config/channels.js";
import { configFile } from "../config/paths.js";
import { PROMPT_TOKENS } from "../config/prompts.js";
import { PROMPT_KEYS } from "../config/schema.js";
import { allPrompts, loadConfig, updateConfig } from "../config/store.js";
import { loadSyncState, SYNCED_SETTINGS } from "../config/sync.js";
import { sessionHost, TERMINAL_DEFINITIONS } from "../terminals/registry.js";
import { UserFacingError } from "../util/errors.js";
import { runsAs, terminalSummary } from "./shared.js";

export async function agents(id?: string): Promise<void> {
  const wanted = id?.trim().toLowerCase();
  if (wanted) {
    const def = AGENT_DEFINITIONS.find((d) => d.id === wanted);
    if (!def) {
      throw new UserFacingError(
        `Unknown agent "${id}".`,
        `Pick one of: ${AGENT_DEFINITIONS.map((d) => d.id).join(", ")}.`,
      );
    }
    await updateConfig((config) => {
      // A custom command belongs to the previous agent; don't carry it over.
      if (config.settings.agent.id !== def.id) config.settings.agent = { id: def.id, command: "", args: [] };
    });
    const { terminal } = (await loadConfig()).settings;
    console.log(`New sessions will use ${def.label} in ${sessionHost(def, terminal)}. A running daemon picks this up on the next click.`);
    if (!def.app && terminal === "headless" && !def.headless) {
      console.log(`${def.label} has no headless mode, so sessions will fail until you pick a terminal: \`sidequest terminal\`.`);
    }
    return;
  }

  const config = await loadConfig();
  const activeId = resolveAgent(config.settings.agent).id;
  console.log("Agents Sidequest can launch:\n");
  for (const def of AGENT_DEFINITIONS) {
    const marker = def.id === activeId ? "  (active)" : "";
    const where = sessionHost(def, config.settings.terminal);
    const agent = resolveAgent({ id: def.id, command: "", args: [] });
    const description = describeAgent(agent);
    console.log(`  ${def.id}${marker}`);
    console.log(`    ${def.label} — ${def.app ? description : `${description}, in ${where}`}`);
    if (!def.app) console.log(`      headless: ${describeHeadless(agent) || "no"}`);
  }
  console.log("\nSwitch with `sidequest agents <id>`, or in " + `${configFile()}:`);
  console.log(`  { "settings": { "agent": { "id": "gemini" } } }`);
  console.log(
    "`command` and `args` override a terminal agent's executable and flags; the prompt still goes last. " +
      "`sidequest terminal` picks the terminal.",
  );
  console.log("An app agent opens a new session in the worktree with the prompt ready; press Enter there to start it.");
}

export async function terminal(name?: string): Promise<void> {
  const wanted = name?.trim().toLowerCase();
  if (wanted) {
    const def = TERMINAL_DEFINITIONS.find((d) => d.id === wanted);
    if (!def) {
      throw new UserFacingError(
        `Unknown terminal "${name}".`,
        `Pick one of: ${TERMINAL_DEFINITIONS.map((d) => d.id).join(", ")}.`,
      );
    }
    const config = await loadConfig();
    const agent = resolveAgent(config.settings.agent, config.settings);
    // Refused here rather than on the next click, which would fail in Slack.
    if (def.id === "headless" && !agent.app && !agent.headless) {
      throw new UserFacingError(
        `${agent.label} has no headless mode.`,
        "Switch agents with `sidequest agents` first.",
      );
    }
    await updateConfig((c) => {
      c.settings.terminal = def.id;
    });
    console.log(
      def.id === "headless"
        ? "New sessions will run in the background, with no terminal. A running daemon picks this up on the next click."
        : `New sessions will open in ${def.label}. A running daemon picks this up on the next click.`,
    );
    console.log(
      agent.app
        ? `${agent.label} opens in ${agent.host} whatever this says; it applies once you switch to a terminal agent.`
        : "`sidequest doctor` checks it's usable.",
    );
    return;
  }

  const config = await loadConfig();
  console.log("Terminals sessions can open in:\n");
  for (const def of TERMINAL_DEFINITIONS) {
    const marker = def.id === config.settings.terminal ? "  (active)" : "";
    console.log(`  ${def.id}${marker}`);
    console.log(`    ${def.label} — ${def.summary}`);
  }
  console.log("\nSwitch with `sidequest terminal <name>`, or in " + `${configFile()}:`);
  console.log(`  { "settings": { "terminal": "iterm2" } }`);
}

export async function replies(state?: string): Promise<void> {
  const wanted = state?.trim().toLowerCase();
  if (wanted) {
    if (wanted !== "on" && wanted !== "off") {
      throw new UserFacingError(`Unknown state "${state}".`, "Use `sidequest replies on` or `sidequest replies off`.");
    }
    await updateConfig((config) => {
      config.settings.autoReply = wanted === "on";
    });
    console.log(
      wanted === "on"
        ? "New sessions will reply in the message's thread, as you. A running daemon picks this up on the next click."
        : "New sessions will not reply in Slack.",
    );
    return;
  }

  const config = await loadConfig();
  console.log(`Thread replies are ${config.settings.autoReply ? "on" : "off"}.\n`);
  for (const { prompt } of allPrompts(config)) {
    console.log(`  ${prompt.label.padEnd(12)} ${prompt.reply.trim() || "(no reply)"}`);
  }
  console.log(`\nTurn them ${config.settings.autoReply ? "off" : "on"} with \`sidequest replies ${config.settings.autoReply ? "off" : "on"}\`.`);
  console.log(`Change one in ${configFile()}:`);
  console.log(`  { "prompts": { "fix": { "reply": "On it, fixing this now." } } }`);
  console.log('An empty "reply" turns it off for that prompt.');
}

export async function skipPermissions(state?: string): Promise<void> {
  const wanted = state?.trim().toLowerCase();
  if (wanted) {
    if (wanted !== "on" && wanted !== "off") {
      throw new UserFacingError(
        `Unknown state "${state}".`,
        "Use `sidequest skip-permissions on` or `sidequest skip-permissions off`.",
      );
    }
    await updateConfig((config) => {
      config.settings.skipPermissions = wanted === "on";
    });
  }

  const config = await loadConfig();
  const on = config.settings.skipPermissions;
  const agent = resolveAgent(config.settings.agent, config.settings);
  if (!on) {
    console.log(
      wanted
        ? "New sessions will ask before acting again, as each agent's own settings say."
        : "Sessions ask before acting, as each agent's own settings say. `sidequest skip-permissions on` starts them with prompts off.",
    );
    return;
  }
  console.log(
    wanted
      ? "New sessions will start with permission prompts off. A running daemon picks this up on the next click."
      : "Permission prompts are off for new sessions.",
  );
  console.log(
    agent.skipsPermissions
      ? `  ${agent.label} runs as: ${runsAs(config, agent)}`
      : `  ${agent.label} has no flag for this, so it still asks.`,
  );
  console.log(
    "\nThe prompt carries the Slack message, so whoever wrote it can steer an agent that runs any command\n" +
      "without asking. Keep it to channels you trust. `sidequest skip-permissions off` turns it back.",
  );
}

export async function sync(state?: string): Promise<void> {
  const wanted = state?.trim().toLowerCase();
  if (wanted) {
    if (wanted !== "on" && wanted !== "off") {
      throw new UserFacingError(`Unknown state "${state}".`, "Use `sidequest sync on` or `sidequest sync off`.");
    }
    await updateConfig((config) => {
      config.settings.sync = wanted === "on";
    });
    if (wanted === "off") {
      console.log("Settings sync is off. The note stays in your DM with yourself in Slack; delete it there if you like.");
      return;
    }
    console.log("Settings sync is on. While Sidequest is running, your channel links, prompts and settings are kept");
    console.log("in a pinned note in your DM with yourself in Slack, and every computer with sync on shares them.");
    console.log("Run `sidequest sync on` on your other computers too. Each one finds its own checkout of a linked repo");
    console.log("by its git remote, wherever it is cloned there.");
    return;
  }

  const config = await loadConfig();
  const synced = await loadSyncState();
  console.log(`Settings sync is ${config.settings.sync ? "on" : "off"}.`);
  if (synced.syncedAt) {
    console.log(`Last in step with Slack at ${synced.syncedAt}${synced.from ? `, as changed on ${synced.from}` : ""}.`);
  }
  const waiting = Object.entries(synced.pending).flatMap(([channel, links]) =>
    links.map(({ link }) => `  #${channel} → ${link.remote || link.name}`),
  );
  if (waiting.length > 0) {
    console.log("\nLinked on another computer, but not cloned on this one (looked for in your usual code folders):");
    for (const line of waiting) console.log(line);
    console.log("Clone them, or add the folder they are in to settings.repoSearchRoots, and they link themselves.");
  }
  console.log(`\nWhat syncs: channel links, prompts, and ${SYNCED_SETTINGS.join(", ")}.`);
  console.log("What stays on this computer: repo paths, worktreesRoot, the terminal, repoSearchRoots, and Slack's DevTools port.");
  console.log(`Turn it ${config.settings.sync ? "off" : "on"} with \`sidequest sync ${config.settings.sync ? "off" : "on"}\`.`);
}

export async function prompts(): Promise<void> {
  const config = await loadConfig();
  for (const { key, prompt } of allPrompts(config)) {
    const builtIn = (PROMPT_KEYS as readonly string[]).includes(key);
    const overridden = config.prompts[key] !== undefined;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`${prompt.label}  (key: ${key}, branch prefix: ${prompt.branchPrefix}/)`);
    console.log(!builtIn ? "your own, from config.json" : overridden ? "customised in config.json" : "built-in default");
    console.log("=".repeat(70));
    console.log(prompt.template);
  }
  const hidden = Object.entries(config.prompts).filter(([, p]) => p.hidden).map(([key]) => key);
  console.log(`\n${"=".repeat(70)}`);
  if (hidden.length > 0) console.log(`Hidden from the menu: ${hidden.join(", ")}`);
  console.log(`Override any of these under "prompts" in ${configFile()}, or add your own:`);
  console.log(`  { "prompts": { "write-test": { "label": "Write a test", "template": "..." } } }`);
  console.log(`Tokens: ${PROMPT_TOKENS.map((t) => `{{${t}}}`).join(", ")}`);
}

export async function list(): Promise<void> {
  const config = await loadConfig();
  const entries = Object.entries(config.channels);
  const agent = resolveAgent(config.settings.agent, config.settings);

  console.log(`config: ${configFile()}\n`);
  console.log("settings");
  console.log(`  worktreesRoot:  ${config.settings.worktreesRoot}`);
  console.log(`  terminal:       ${terminalSummary(config.settings.terminal, agent)}`);
  if (config.settings.terminal === "warp" && !agent.app) {
    console.log(`  warpStrategy:   ${config.settings.warpStrategy}${config.settings.warpPreview ? " (preview)" : ""}`);
  }
  console.log(`  agent:          ${agent.label} (${runsAs(config, agent)})`);
  if (config.settings.skipPermissions) {
    console.log(`  permissions:    ${agent.skipsPermissions ? "skipped, no prompts" : `skipPermissions is on, but ${agent.label} has no flag for it`}`);
  }
  console.log(`  threadContext:  ${config.settings.threadContextLimit} messages`);
  console.log(
    `  autoClean:      ${config.settings.autoClean ? `on, after ${config.settings.autoCleanAfterDays} idle days` : "off"}`,
  );
  console.log(`  sync:           ${config.settings.sync ? "on, through Slack" : "off"}`);

  console.log("\nlinked channels");
  if (entries.length === 0) {
    console.log("  (none yet — hover a message in Slack, click Sidequest, and pick a repo)");
    return;
  }
  for (const [id, links] of entries) {
    for (const [i, l] of links.entries()) {
      const tag = links.length > 1 && i === 0 ? "   (default)" : "";
      console.log(`  #${id} → ${l.repoPath}${tag}`);
      console.log(`      base: ${l.baseBranch || "(detected)"}   label: ${linkLabel(l)}`);
    }
  }
}
