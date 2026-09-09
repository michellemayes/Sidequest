import type { WebClient } from "@slack/web-api";
import type { MessageContext } from "../session/create.js";
import { log } from "../util/log.js";

export interface RawMessage {
  channelId: string;
  channelName: string;
  ts: string;
  text: string;
  userId?: string;
  threadTs?: string;
}

/**
 * Fill in everything the prompt template needs that the shortcut payload does
 * not carry: display names, a permalink, and the surrounding thread.
 *
 * Every lookup here is best-effort. A missing scope or a deleted user should
 * degrade the prompt, never fail the session.
 */
export async function buildMessageContext(
  client: WebClient,
  raw: RawMessage,
  threadContextLimit: number,
): Promise<MessageContext> {
  const [authorName, permalink, threadMessages] = await Promise.all([
    resolveUserName(client, raw.userId),
    resolvePermalink(client, raw.channelId, raw.ts),
    threadContextLimit > 0 ? resolveThread(client, raw, threadContextLimit) : Promise.resolve([]),
  ]);

  return {
    channelId: raw.channelId,
    channelName: raw.channelName,
    authorName,
    text: raw.text,
    ts: raw.ts,
    permalink,
    threadMessages,
  };
}

const userNameCache = new Map<string, string>();

export async function resolveUserName(client: WebClient, userId?: string): Promise<string> {
  if (!userId) return "unknown";
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.name?.trim() ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch (err) {
    log.debug(`users.info failed for ${userId}`, err);
    return userId;
  }
}

async function resolvePermalink(
  client: WebClient,
  channel: string,
  ts: string,
): Promise<string> {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    return result.permalink ?? "(unavailable)";
  } catch (err) {
    log.debug("chat.getPermalink failed", err);
    return "(unavailable)";
  }
}

/**
 * Pull the thread the message belongs to. When the clicked message is itself a
 * reply we still want the parent and siblings, which is why we key off
 * thread_ts and drop the clicked message from the result.
 */
async function resolveThread(
  client: WebClient,
  raw: RawMessage,
  limit: number,
): Promise<Array<{ author: string; text: string }>> {
  const threadTs = raw.threadTs;
  if (!threadTs) return [];

  try {
    const result = await client.conversations.replies({
      channel: raw.channelId,
      ts: threadTs,
      limit: Math.min(limit + 1, 50),
    });
    const messages = result.messages ?? [];

    const others = messages.filter((m) => m.ts !== raw.ts);
    return Promise.all(
      others.map(async (m) => ({
        author: await resolveUserName(client, m.user),
        text: m.text ?? "",
      })),
    );
  } catch (err) {
    log.debug("conversations.replies failed; continuing without thread context", err);
    return [];
  }
}

/**
 * Channel names are absent from some payloads (and always for DMs), so fall
 * back to an API lookup and then to the raw id.
 */
export async function resolveChannelName(
  client: WebClient,
  channelId: string,
  fromPayload?: string,
): Promise<string> {
  if (fromPayload && fromPayload.length > 0 && fromPayload !== "directmessage") {
    return fromPayload;
  }
  try {
    const result = await client.conversations.info({ channel: channelId });
    return result.channel?.name ?? channelId;
  } catch {
    return channelId;
  }
}
