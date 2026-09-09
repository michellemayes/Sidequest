import { z } from "zod";
import { defaultWorktreesRoot } from "./paths.js";

export const PROMPT_KEYS = ["investigate", "fix", "review"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export const promptSchema = z.object({
  /** Shown on the Slack button and in the Warp tab title. */
  label: z.string().min(1),
  emoji: z.string().default(""),
  /** Template body; see src/config/prompts.ts for the supported {{tokens}}. */
  template: z.string().min(1),
  /** Branch name fragment, e.g. "investigate" -> claude/investigate-<slug>. */
  branchPrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "branchPrefix must be lowercase alphanumeric with dashes")
    .default("claude"),
});

export type PromptConfig = z.infer<typeof promptSchema>;

export const repoLinkSchema = z.object({
  /** Absolute path to the main git checkout. */
  repoPath: z.string().min(1),
  /** Branch new worktrees are cut from. Empty means "detect the default". */
  baseBranch: z.string().default(""),
  /** Human label used in Slack replies; defaults to the directory name. */
  label: z.string().default(""),
  linkedBy: z.string().default(""),
  linkedAt: z.string().default(""),
});

export type RepoLink = z.infer<typeof repoLinkSchema>;

export const warpStrategySchema = z.enum(["launch_config", "tab_config", "new_tab"]);
export type WarpStrategy = z.infer<typeof warpStrategySchema>;

export const settingsSchema = z.object({
  /** Parent directory that holds every generated worktree. */
  worktreesRoot: z.string().default(defaultWorktreesRoot()),
  /**
   * How to open Warp. `launch_config` gives a titled tab and tries to run the
   * command itself; `new_tab` is the most compatible and leans on the shell
   * hook to run the command.
   */
  warpStrategy: warpStrategySchema.default("launch_config"),
  /** Use the Warp Preview build (warppreview:// scheme). */
  warpPreview: z.boolean().default(false),
  /** The command that starts Claude Code; the prompt is appended as one argument. */
  claudeCommand: z.string().default("claude"),
  /** Extra flags passed to claudeCommand before the prompt. */
  claudeArgs: z.array(z.string()).default([]),
  /** Pull the base branch before cutting the worktree. */
  fetchBeforeCreate: z.boolean().default(true),
  /** How many messages of surrounding thread context to include. */
  threadContextLimit: z.number().int().min(0).max(50).default(10),
  /** Delete the worktree's branch too when running `ccslack clean`. */
  pruneBranchesOnClean: z.boolean().default(true),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * A user override for one prompt. Every field is optional: whatever is omitted
 * falls back to the built-in default in src/config/prompts.ts.
 */
export const promptOverrideSchema = z.object({
  label: z.string().min(1).optional(),
  emoji: z.string().optional(),
  template: z.string().min(1).optional(),
  branchPrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "branchPrefix must be lowercase alphanumeric with dashes")
    .optional(),
});

export type PromptOverride = z.infer<typeof promptOverrideSchema>;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  settings: settingsSchema.default({}),
  /** Slack channel id -> repo link. */
  channels: z.record(z.string(), repoLinkSchema).default({}),
  /** Per-prompt overrides of the built-in defaults. */
  prompts: z
    .object({
      investigate: promptOverrideSchema.optional(),
      fix: promptOverrideSchema.optional(),
      review: promptOverrideSchema.optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
