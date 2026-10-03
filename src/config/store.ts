import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { configFile, configRoot } from "./paths.js";
import { DEFAULT_PROMPTS } from "./prompts.js";
import {
  configSchema,
  promptSchema,
  type Config,
  type PromptConfig,
  type PromptKey,
} from "./schema.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";
import { acquireLock, pidExists, releaseLock } from "../util/lockfile.js";

/** Bring a config written by an older version up to the current schema, in place. */
function migrate(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const settings = (raw as Record<string, unknown>).settings;
  if (typeof settings !== "object" || settings === null) return raw;
  const s = settings as Record<string, unknown>;

  // settings.claudeCommand/claudeArgs became settings.agent. The schema would
  // strip the old keys anyway; this keeps the user's values.
  if (s.agent === undefined && (s.claudeCommand !== undefined || s.claudeArgs !== undefined)) {
    s.agent = {
      id: "claude",
      command: typeof s.claudeCommand === "string" ? s.claudeCommand : "",
      args: Array.isArray(s.claudeArgs) ? s.claudeArgs : [],
    };
  }
  delete s.claudeCommand;
  delete s.claudeArgs;

  // `init` used to write the old default, `launch_config`, into every config.
  // On its own it cannot start a session while Warp is running (Warp reads
  // launch configs only at startup), so `auto`, which still tries a launch
  // config after a tab config.
  if (s.warpStrategy === "launch_config") s.warpStrategy = "auto";
  return raw;
}

/** Expand a leading ~ and make the path absolute. */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  const expanded = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function emptyConfig(): Config {
  return configSchema.parse({});
}

export async function loadConfig(): Promise<Config> {
  const file = configFile();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UserFacingError(
      `${file} is not valid JSON: ${(err as Error).message}`,
      "Fix the file by hand, or delete it to start over.",
    );
  }

  const result = configSchema.safeParse(migrate(parsed));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new UserFacingError(`${file} has invalid settings:\n${issues}`);
  }
  return result.data;
}

/**
 * Write atomically so a crash mid-write cannot leave a truncated config: the
 * temp file is flushed to disk before the rename, or a power cut could leave
 * the rename in place with nothing behind it.
 */
export async function saveConfig(config: Config): Promise<void> {
  const file = configFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  log.debug(`wrote ${file}`);
}

/** How long updateConfig waits for another process's update before giving up. */
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
/**
 * A lock older than this is debris whoever holds it: an update is a read, a
 * small edit and a write, so even a live holder (or a reused pid) that has
 * kept it this long is not coming back for it.
 */
const CONFIG_LOCK_STALE_MS = 30_000;

/**
 * Read, mutate and persist the config in one call.
 *
 * The daemon, the overlay's requests and the CLI all update the same file, so
 * without a lock two of them can read the same version and the second write
 * drops the first one's change (a channel linked from Slack while
 * `sidequest replies off` runs in a terminal). The lock is a file beside the
 * config, held across the read and the write.
 */
export async function updateConfig<T>(mutate: (config: Config) => T | Promise<T>): Promise<T> {
  const file = configFile();
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const holder = await acquireLock(lock, {
    timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
    isStale: (h, ageMs) =>
      ageMs > CONFIG_LOCK_STALE_MS || (h === null ? ageMs > 2_000 : !pidExists(h.pid)),
  });
  if (holder !== null) {
    throw new UserFacingError(
      `Another Sidequest process (pid ${holder.pid}) is still writing ${file}.`,
      `Try again in a moment. If it keeps happening, delete ${lock}.`,
    );
  }
  try {
    const config = await loadConfig();
    const result = await mutate(config);
    await saveConfig(config);
    return result;
  } finally {
    await releaseLock(lock).catch(() => undefined);
  }
}

export async function ensureConfigRoot(): Promise<string> {
  const root = configRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

const isBuiltIn = (key: string): key is PromptKey => Object.hasOwn(DEFAULT_PROMPTS, key);

/**
 * One prompt as it stands: a built-in with the user's override merged over
 * it, or a prompt of the user's own. Null for a key that is neither.
 */
export function promptFor(config: Config, key: string): PromptConfig | null {
  const override = Object.hasOwn(config.prompts, key) ? config.prompts[key] : undefined;
  // Drop undefined keys so an absent override never clobbers a default.
  const defined = Object.fromEntries(
    Object.entries(override ?? {}).filter(([field, value]) => value !== undefined && field !== "hidden"),
  );
  if (isBuiltIn(key)) {
    return override ? promptSchema.parse({ ...DEFAULT_PROMPTS[key], ...defined }) : DEFAULT_PROMPTS[key];
  }
  if (!override) return null;
  // Named for its key unless it says otherwise, so its branches are findable.
  return promptSchema.parse({ branchPrefix: key, ...defined });
}

/**
 * Every prompt the menu offers, in menu order: the built-ins first, then the
 * user's own in the order the config lists them. Hidden ones are left out.
 */
export function allPrompts(config: Config): Array<{ key: string; prompt: PromptConfig }> {
  const keys = [
    ...Object.keys(DEFAULT_PROMPTS),
    ...Object.keys(config.prompts).filter((key) => !isBuiltIn(key)),
  ];
  const out: Array<{ key: string; prompt: PromptConfig }> = [];
  for (const key of keys) {
    if (config.prompts[key]?.hidden) continue;
    const prompt = promptFor(config, key);
    if (prompt) out.push({ key, prompt });
  }
  return out;
}
