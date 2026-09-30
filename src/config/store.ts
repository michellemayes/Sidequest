import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  type Settings,
} from "./schema.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";

/**
 * Migrate pre-agent configs: settings.claudeCommand/claudeArgs become
 * settings.agent. Unknown keys would be stripped by the schema anyway; this
 * preserves the user's values instead of dropping them.
 */
function migrateAgentSettings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const settings = (raw as Record<string, unknown>).settings;
  if (typeof settings !== "object" || settings === null) return raw;
  const s = settings as Record<string, unknown>;
  if (s.agent === undefined && (s.claudeCommand !== undefined || s.claudeArgs !== undefined)) {
    s.agent = {
      id: "claude",
      command: typeof s.claudeCommand === "string" ? s.claudeCommand : "",
      args: Array.isArray(s.claudeArgs) ? s.claudeArgs : [],
    };
  }
  delete s.claudeCommand;
  delete s.claudeArgs;
  return raw;
}

/**
 * `init` used to write the old default, `launch_config`, into every config.
 * On its own it cannot start a session while Warp is running (Warp reads
 * launch configs only at startup), so move those configs to `auto`, which
 * still tries a launch config after a tab config.
 */
function migrateWarpStrategy(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const settings = (raw as Record<string, unknown>).settings;
  if (typeof settings !== "object" || settings === null) return raw;
  const s = settings as Record<string, unknown>;
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

  const result = configSchema.safeParse(migrateWarpStrategy(migrateAgentSettings(parsed)));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new UserFacingError(`${file} has invalid settings:\n${issues}`);
  }
  return result.data;
}

/** Write atomically so a crash mid-write cannot leave a truncated config. */
export async function saveConfig(config: Config): Promise<void> {
  const file = configFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  log.debug(`wrote ${file}`);
}

/** Read, mutate and persist the config in one call. */
export async function updateConfig<T>(mutate: (config: Config) => T | Promise<T>): Promise<T> {
  const config = await loadConfig();
  const result = await mutate(config);
  await saveConfig(config);
  return result;
}

export async function ensureConfigRoot(): Promise<string> {
  const root = configRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export function settingsOf(config: Config): Settings {
  return config.settings;
}

/** A user override merged over the built-in default for one prompt. */
export function promptFor(config: Config, key: PromptKey): PromptConfig {
  const override = config.prompts[key];
  if (!override) return DEFAULT_PROMPTS[key];
  // Drop undefined keys so an absent override never clobbers a default.
  const defined = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  );
  return promptSchema.parse({ ...DEFAULT_PROMPTS[key], ...defined });
}

export function allPrompts(config: Config): Array<{ key: PromptKey; prompt: PromptConfig }> {
  return (Object.keys(DEFAULT_PROMPTS) as PromptKey[]).map((key) => ({
    key,
    prompt: promptFor(config, key),
  }));
}
