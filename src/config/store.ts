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
  type RepoLink,
  type Settings,
} from "./schema.js";
import { UserFacingError } from "../util/errors.js";
import { log } from "../util/log.js";

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

  const result = configSchema.safeParse(parsed);
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

export function repoForChannel(config: Config, channelId: string): RepoLink | undefined {
  return config.channels[channelId];
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
