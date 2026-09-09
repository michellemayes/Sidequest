import { expandPath, loadConfig, updateConfig } from "../config/store.js";
import { inspectRepo } from "../git/repo.js";
import { listWorktrees } from "../git/worktree.js";
import { labelForLink } from "../session/create.js";
import { UserFacingError } from "../util/errors.js";

export interface CommandRequest {
  channelId: string;
  channelName: string;
  userId: string;
  /** Everything after the slash command itself. */
  text: string;
}

export interface CommandReply {
  text: string;
  /** Only the invoking user sees ephemeral replies. */
  ephemeral: boolean;
}

const HELP = [
  "*ccslack*",
  "`/ccslack link <path> [--base <branch>] [--label <name>]` — link this channel to a repo",
  "`/ccslack unlink` — remove this channel's link",
  "`/ccslack status` — show what this channel is linked to",
  "`/ccslack list` — list every linked channel",
  "`/ccslack sessions` — list live worktrees for this channel's repo",
  "",
  "Once a channel is linked, use a message's *More actions* (⋮) menu to start Investigate, Fix or Review.",
].join("\n");

/**
 * Handle `/ccslack ...`. Replies are always ephemeral: repo paths are local to
 * one machine and are noise for everyone else in the channel.
 */
export async function handleCommand(request: CommandRequest): Promise<CommandReply> {
  const args = tokenize(request.text);
  const sub = (args.shift() ?? "help").toLowerCase();

  switch (sub) {
    case "link":
      return ephemeral(await link(request, args));
    case "unlink":
      return ephemeral(await unlink(request));
    case "status":
      return ephemeral(await status(request));
    case "list":
      return ephemeral(await list());
    case "sessions":
      return ephemeral(await sessions(request));
    case "help":
    case "":
      return ephemeral(HELP);
    default:
      return ephemeral(`Unknown subcommand \`${sub}\`.\n\n${HELP}`);
  }
}

function ephemeral(text: string): CommandReply {
  return { text, ephemeral: true };
}

/**
 * Split on whitespace, honouring quotes so paths with spaces survive.
 * Slack also smart-quotes text typed in the client, so treat curly quotes as
 * plain ones.
 */
export function tokenize(input: string): string[] {
  const normalized = input.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter((t) => t.length > 0);
}

async function link(request: CommandRequest, args: string[]): Promise<string> {
  const { positional, flags } = parseFlags(args);
  const rawPath = positional[0];
  if (!rawPath) {
    throw new UserFacingError("Usage: `/ccslack link <path> [--base <branch>] [--label <name>]`");
  }

  const repo = await inspectRepo(expandPath(rawPath));
  const baseBranch = flags.base ?? "";
  const label = flags.label ?? "";

  await updateConfig((config) => {
    config.channels[request.channelId] = {
      repoPath: repo.root,
      baseBranch,
      label,
      linkedBy: request.userId,
      linkedAt: new Date().toISOString(),
    };
  });

  const effectiveBase = baseBranch || repo.defaultBranch;
  return [
    `Linked *#${request.channelName}* to \`${repo.root}\`.`,
    `Sessions will branch from \`${effectiveBase}\`${baseBranch ? "" : " (detected)"}.`,
  ].join("\n");
}

async function unlink(request: CommandRequest): Promise<string> {
  const existed = await updateConfig((config) => {
    const had = Boolean(config.channels[request.channelId]);
    delete config.channels[request.channelId];
    return had;
  });
  return existed
    ? `Unlinked *#${request.channelName}*.`
    : `*#${request.channelName}* was not linked to anything.`;
}

async function status(request: CommandRequest): Promise<string> {
  const config = await loadConfig();
  const link = config.channels[request.channelId];
  if (!link) {
    return `*#${request.channelName}* is not linked. Try \`/ccslack link ~/path/to/repo\`.`;
  }

  const repo = await inspectRepo(link.repoPath);
  return [
    `*#${request.channelName}* → \`${link.repoPath}\``,
    `• base branch: \`${link.baseBranch || repo.defaultBranch}\`${link.baseBranch ? "" : " (detected)"}`,
    `• label: \`${labelForLink(link)}\``,
    `• worktrees go to \`${config.settings.worktreesRoot}\``,
  ].join("\n");
}

async function list(): Promise<string> {
  const config = await loadConfig();
  const entries = Object.entries(config.channels);
  if (entries.length === 0) return "No channels are linked yet.";
  return [
    "*Linked channels*",
    ...entries.map(([id, l]) => `• \`${id}\` → \`${l.repoPath}\``),
  ].join("\n");
}

async function sessions(request: CommandRequest): Promise<string> {
  const config = await loadConfig();
  const link = config.channels[request.channelId];
  if (!link) return `*#${request.channelName}* is not linked to a repo.`;

  const worktrees = (await listWorktrees(link.repoPath)).filter((w) => !w.isMain);
  if (worktrees.length === 0) return `No active worktrees in \`${link.repoPath}\`.`;

  return [
    `*Active worktrees in \`${labelForLink(link)}\`*`,
    ...worktrees.map((w) => `• \`${w.branch}\` — \`${w.path}\`${w.isPrunable ? " _(stale)_" : ""}`),
  ].join("\n");
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

/** Parse `--key value` pairs, leaving everything else positional. */
export function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = splitOnce(arg.slice(2), "=");
      if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = "";
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}
