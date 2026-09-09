import type { KnownBlock } from "@slack/types";
import type { SessionResult } from "../session/create.js";
import type { PromptConfig, PromptKey, RepoLink } from "../config/schema.js";

/** Callback id for the picker shortcut, and the action id prefix for its buttons. */
export const PICKER_CALLBACK_ID = "ccslack_start";
export const PICKER_ACTION_PREFIX = "ccslack_prompt_";

/** Callback id per direct shortcut, e.g. ccslack_fix. */
export function shortcutCallbackId(key: PromptKey): string {
  return `ccslack_${key}`;
}

export function pickerActionId(key: PromptKey): string {
  return `${PICKER_ACTION_PREFIX}${key}`;
}

export function promptKeyFromActionId(actionId: string): string | null {
  if (!actionId.startsWith(PICKER_ACTION_PREFIX)) return null;
  return actionId.slice(PICKER_ACTION_PREFIX.length);
}

/** Value carried on a picker button so the handler can rebuild the message. */
export interface PickerValue {
  channelId: string;
  channelName: string;
  ts: string;
  threadTs?: string;
  userId?: string;
  text: string;
}

/**
 * Slack caps a button `value` at 2000 characters, so the message text is
 * truncated before it is round-tripped through the button.
 */
export function encodePickerValue(value: PickerValue): string {
  const encoded = JSON.stringify(value);
  if (encoded.length <= 1900) return encoded;
  const budget = Math.max(0, value.text.length - (encoded.length - 1900));
  return JSON.stringify({ ...value, text: value.text.slice(0, budget) });
}

export function decodePickerValue(raw: string): PickerValue {
  return JSON.parse(raw) as PickerValue;
}

export function pickerBlocks(
  prompts: Array<{ key: PromptKey; prompt: PromptConfig }>,
  value: PickerValue,
  link: RepoLink | undefined,
  repoLabel: string,
): KnownBlock[] {
  const encoded = encodePickerValue(value);

  const header: KnownBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: link
        ? `*Start a Claude Code session*\nRepo: \`${repoLabel}\` — each option cuts a fresh worktree and opens it in Warp.`
        : `*No repo linked to this channel*\nRun \`/ccslack link ~/path/to/repo\` here first.`,
    },
  };

  if (!link) return [header];

  return [
    header,
    {
      type: "actions",
      elements: prompts.map(({ key, prompt }) => ({
        type: "button" as const,
        action_id: pickerActionId(key),
        text: {
          type: "plain_text" as const,
          text: prompt.emoji ? `:${prompt.emoji}: ${prompt.label}` : prompt.label,
          emoji: true,
        },
        value: encoded,
      })),
    },
  ];
}

export function successBlocks(result: SessionResult): KnownBlock[] {
  const opened = result.launchError === undefined;
  const lines = [
    opened
      ? `*${result.promptLabel}* session started in \`${result.repoLabel}\``
      : `*${result.promptLabel}* worktree is ready in \`${result.repoLabel}\`, but Warp did not open`,
    `• branch \`${result.branch}\` off \`${result.baseBranch}\``,
    `• worktree \`${result.worktreePath}\``,
  ];

  if (!opened) {
    lines.push(`• ${result.launchError}`);
    lines.push(`• start it by hand: \`cd ${result.worktreePath} && .ccslack/autorun.sh\``);
  } else if (result.fellBackToNewTab) {
    lines.push(
      "• Warp opened the folder but could not run the command itself — " +
        "run `ccslack install-hook` so future sessions start Claude automatically.",
    );
  }

  return [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
}

export function errorBlocks(message: string, hint?: string): KnownBlock[] {
  const text = hint ? `:warning: ${message}\n_${hint}_` : `:warning: ${message}`;
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}
