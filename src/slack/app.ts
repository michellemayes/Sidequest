import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { PROMPT_KEYS, type PromptKey } from "../config/schema.js";
import { allPrompts, loadConfig } from "../config/store.js";
import { createSession, labelForLink } from "../session/create.js";
import { buildMessageContext, resolveChannelName } from "./context.js";
import {
  PICKER_CALLBACK_ID,
  decodePickerValue,
  errorBlocks,
  pickerActionId,
  pickerBlocks,
  shortcutCallbackId,
  successBlocks,
  type PickerValue,
} from "./blocks.js";
import { handleCommand } from "./commands.js";
import { describeError, UserFacingError } from "../util/errors.js";
import { envFile } from "../config/paths.js";
import { log } from "../util/log.js";

export interface SlackCredentials {
  botToken: string;
  appToken: string;
}

/**
 * Read and sanity-check both tokens.
 *
 * `ccslack init` writes the bare prefixes as placeholders, so a prefix match
 * alone is not enough — check there is an actual token after it, or the first
 * run fails later with an opaque Slack auth error instead of here.
 */
export function readCredentials(): SlackCredentials {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim() ?? "";
  const appToken = process.env.SLACK_APP_TOKEN?.trim() ?? "";

  const missing: string[] = [];
  if (!botToken) missing.push("SLACK_BOT_TOKEN");
  if (!appToken) missing.push("SLACK_APP_TOKEN");
  if (missing.length > 0) {
    throw new UserFacingError(
      `Missing ${missing.join(" and ")}.`,
      `Add them to ${envFile()} — see the README for where each one comes from.`,
    );
  }

  assertTokenShape(
    botToken,
    "xoxb-",
    "SLACK_BOT_TOKEN",
    "OAuth & Permissions -> Bot User OAuth Token, after installing the app",
  );
  assertTokenShape(
    appToken,
    "xapp-",
    "SLACK_APP_TOKEN",
    "Basic Information -> App-Level Tokens, with the connections:write scope",
  );

  return { botToken, appToken };
}

function assertTokenShape(value: string, prefix: string, name: string, where: string): void {
  if (!value.startsWith(prefix)) {
    throw new UserFacingError(`${name} must start with \`${prefix}\`.`, `Find it under ${where}.`);
  }
  if (value.length <= prefix.length + 8) {
    throw new UserFacingError(
      `${name} is still the placeholder \`${prefix}\`.`,
      `Paste the real token from ${where}.`,
    );
  }
}

/**
 * Confirm the bot token actually authenticates, so `ccslack doctor` fails here
 * rather than at the first button click.
 */
export async function verifyCredentials(
  credentials: SlackCredentials,
): Promise<{ team: string; bot: string }> {
  const client = new WebClient(credentials.botToken);
  const result = await client.auth.test();
  return { team: result.team ?? "unknown", bot: result.user ?? "unknown" };
}

export function createSlackApp(credentials: SlackCredentials): App {
  const app = new App({
    token: credentials.botToken,
    appToken: credentials.appToken,
    socketMode: true,
    logLevel: process.env.CCSLACK_LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.WARN,
  });

  registerDirectShortcuts(app);
  registerPicker(app);
  registerSlashCommand(app);

  app.error(async (err) => {
    log.error("unhandled Slack error", err);
  });

  return app;
}

/** One shortcut per prompt: ⋮ → Investigate / Fix / Review, no extra click. */
function registerDirectShortcuts(app: App): void {
  for (const key of PROMPT_KEYS) {
    app.shortcut(shortcutCallbackId(key), async ({ shortcut, ack, client }) => {
      await ack();
      if (shortcut.type !== "message_action") return;

      await startSession(client, key, {
        channelId: shortcut.channel.id,
        channelName: shortcut.channel.name,
        ts: shortcut.message_ts,
        threadTs: asString(shortcut.message.thread_ts),
        userId: shortcut.message.user,
        text: shortcut.message.text ?? "",
      }, shortcut.user.id);
    });
  }
}

/**
 * A single shortcut that posts the three buttons as an ephemeral message —
 * closer to "one button that offers three prompts", and the place to add more
 * prompts without cluttering Slack's actions menu.
 */
function registerPicker(app: App): void {
  app.shortcut(PICKER_CALLBACK_ID, async ({ shortcut, ack, client }) => {
    await ack();
    if (shortcut.type !== "message_action") return;

    const config = await loadConfig();
    const channelName = await resolveChannelName(client, shortcut.channel.id, shortcut.channel.name);
    const link = config.channels[shortcut.channel.id];

    const value: PickerValue = {
      channelId: shortcut.channel.id,
      channelName,
      ts: shortcut.message_ts,
      threadTs: asString(shortcut.message.thread_ts),
      userId: shortcut.message.user,
      text: shortcut.message.text ?? "",
    };

    await postEphemeral(client, shortcut.channel.id, shortcut.user.id, {
      blocks: pickerBlocks(allPrompts(config), value, link, link ? labelForLink(link) : ""),
      text: link ? "Start a Claude Code session" : "No repo linked to this channel",
    });
  });

  for (const key of PROMPT_KEYS) {
    app.action(pickerActionId(key), async ({ body, ack, client, action }) => {
      await ack();
      if (action.type !== "button" || !action.value) return;

      const value = decodePickerValue(action.value);
      const userId = "user" in body && body.user ? body.user.id : "";
      await startSession(client, key, value, userId);
    });
  }
}

function registerSlashCommand(app: App): void {
  app.command("/ccslack", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      const channelName = await resolveChannelName(client, command.channel_id, command.channel_name);
      const reply = await handleCommand({
        channelId: command.channel_id,
        channelName,
        userId: command.user_id,
        text: command.text ?? "",
      });
      await respond({ response_type: reply.ephemeral ? "ephemeral" : "in_channel", text: reply.text });
    } catch (err) {
      const { message, hint } = describeError(err);
      log.error(`/ccslack failed: ${message}`, err);
      await respond({
        response_type: "ephemeral",
        text: hint ? `:warning: ${message}\n_${hint}_` : `:warning: ${message}`,
      });
    }
  });
}

interface RawShortcutMessage {
  channelId: string;
  channelName: string;
  ts: string;
  threadTs?: string;
  userId?: string;
  text: string;
}

/**
 * Shared path for both entry points. Every reply is ephemeral — starting a
 * session is a private action on the clicker's own laptop, so it should not
 * post into the channel.
 */
async function startSession(
  client: WebClient,
  promptKey: PromptKey,
  raw: RawShortcutMessage,
  invokerId: string,
): Promise<void> {
  try {
    const config = await loadConfig();
    const channelName = await resolveChannelName(client, raw.channelId, raw.channelName);

    const context = await buildMessageContext(
      client,
      { ...raw, channelName },
      config.settings.threadContextLimit,
    );

    const result = await createSession(promptKey, context, config);
    await postEphemeral(client, raw.channelId, invokerId, {
      blocks: successBlocks(result),
      text: `${result.promptLabel} session started on ${result.branch}`,
    });
  } catch (err) {
    const { message, hint } = describeError(err);
    log.error(`could not start ${promptKey} session: ${message}`, err);
    await postEphemeral(client, raw.channelId, invokerId, {
      blocks: errorBlocks(message, hint),
      text: message,
    });
  }
}

/**
 * Post privately to the invoker. This fails when the bot is not in the channel,
 * which is the common first-run mistake, so say so rather than failing silently.
 */
async function postEphemeral(
  client: WebClient,
  channel: string,
  user: string,
  body: { blocks: KnownBlock[]; text: string },
): Promise<void> {
  if (!user) return;
  try {
    await client.chat.postEphemeral({ channel, user, blocks: body.blocks, text: body.text });
  } catch (err) {
    const code = (err as { data?: { error?: string } }).data?.error;
    if (code === "channel_not_found" || code === "not_in_channel") {
      log.warn(
        `cannot reply in ${channel}: invite the bot with /invite @ccslack. ` +
          `The session itself was unaffected.`,
      );
      return;
    }
    log.error("chat.postEphemeral failed", err);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
