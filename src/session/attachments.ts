/**
 * Files attached to the message a session starts from: the screenshot in a
 * bug report, a log someone dropped into the thread.
 *
 * Slack serves them only to a signed-in session, which the daemon does not
 * have, so the overlay fetches them in Slack's window and hands the bytes
 * down with the rest of the message. They land in the worktree's
 * git-excluded session directory, where the agent can open them like any
 * other file, and the prompt lists where.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_DIR } from "../warp/autorun.js";
import { log } from "../util/log.js";

/** One file as the overlay sends it. */
export interface IncomingAttachment {
  name: string;
  /** MIME type as Slack served it; informational only. */
  type: string;
  /** The file's bytes, base64. */
  data: string;
}

export interface SavedAttachment {
  /** Relative to the worktree, which is where the agent starts. */
  path: string;
  type: string;
  bytes: number;
}

/**
 * Limits on what a message can bring in. The overlay applies the same ones
 * before it fetches anything; these are the daemon not taking its word for it.
 */
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL = 20 * 1024 * 1024;

export const ATTACHMENTS_DIR = "attachments";

/**
 * A name that is safe as one path segment: no directories, no leading dot,
 * nothing a shell or a Markdown link would trip over.
 */
export function safeFileName(name: string, fallback = "attachment"): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-80);
  return cleaned.replace(/-+(\.[A-Za-z0-9]+)?$/, "$1") || fallback;
}

/** Write what came with the message into the worktree; anything over the limits is skipped. */
export async function saveAttachments(
  worktreePath: string,
  incoming: IncomingAttachment[] | undefined,
): Promise<SavedAttachment[]> {
  if (!Array.isArray(incoming) || incoming.length === 0) return [];
  const dir = join(worktreePath, SESSION_DIR, ATTACHMENTS_DIR);
  const taken = new Set<string>();
  const saved: SavedAttachment[] = [];
  let total = 0;

  for (const [index, file] of incoming.slice(0, MAX_ATTACHMENTS).entries()) {
    if (!file || typeof file.data !== "string") continue;
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length === 0) continue;
    if (bytes.length > MAX_ATTACHMENT_BYTES || total + bytes.length > MAX_ATTACHMENTS_TOTAL) {
      log.warn(`skipped attachment ${file.name}: ${bytes.length} bytes is over the limit`);
      continue;
    }

    let name = safeFileName(file.name, `attachment-${index + 1}`);
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      name = `${stem.replace(/-\d+$/, "")}-${n}${ext}`;
    }
    taken.add(name.toLowerCase());

    if (saved.length === 0) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), bytes);
    total += bytes.length;
    saved.push({
      path: `${SESSION_DIR}/${ATTACHMENTS_DIR}/${name}`,
      type: typeof file.type === "string" ? file.type : "",
      bytes: bytes.length,
    });
  }
  return saved;
}

/** The {{attachments}} section of a prompt; empty when the message had none. */
export function formatAttachments(saved: SavedAttachment[]): string {
  if (saved.length === 0) return "";
  const lines = saved.map((file) => {
    const detail = [file.type, humanSize(file.bytes)].filter(Boolean).join(", ");
    return `- ${file.path} (${detail})`;
  });
  return `\n### Attachments\nFiles attached in Slack, saved in this worktree. Open them — screenshots often show what the words leave out.\n${lines.join("\n")}\n`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
