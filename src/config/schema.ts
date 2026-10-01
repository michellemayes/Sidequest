import { z } from "zod";
import { defaultWorktreesRoot } from "./paths.js";

/** The built-in prompts. Config can add prompts of its own under any other key. */
export const PROMPT_KEYS = ["investigate", "fix", "review", "ask", "linear", "github", "jira"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

/** What a custom prompt's key may look like: it names branches and Warp configs. */
export const PROMPT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
  /**
   * What to post in the message's thread when a session starts, if
   * settings.autoReply is on. Takes the same {{tokens}} as the template.
   * Empty means this prompt never replies.
   */
  reply: z.string().default(""),
});

export type PromptConfig = z.infer<typeof promptSchema>;

export const repoLinkSchema = z.object({
  /** Absolute path to the main git checkout. */
  repoPath: z.string().min(1),
  /** Channel name as Slack renders it, without the leading #. */
  channel: z.string().default(""),
  /** Branch new worktrees are cut from. Empty means "detect the default". */
  baseBranch: z.string().default(""),
  /** Human label used in Slack replies; defaults to the directory name. */
  label: z.string().default(""),
  linkedBy: z.string().default(""),
  linkedAt: z.string().default(""),
});

export type RepoLink = z.infer<typeof repoLinkSchema>;

/**
 * What happens to the reply an agent leaves in .sidequest/result.md: `ask`
 * offers it on the message for you to read, edit and post; `auto` posts it
 * as soon as it is written; `off` does not ask the agent for one at all.
 */
export const postResultsSchema = z.enum(["off", "ask", "auto"]);
export type PostResults = z.infer<typeof postResultsSchema>;

export const warpStrategySchema = z.enum(["auto", "tab_config", "launch_config", "new_tab"]);
export type WarpStrategy = z.infer<typeof warpStrategySchema>;

/**
 * Where a session runs. The macOS terminals open a tab or window in the
 * worktree; `tmux` opens a window in a running tmux server; `headless` runs
 * the agent in the background with no terminal at all.
 */
export const TERMINAL_IDS = ["warp", "iterm2", "ghostty", "terminal", "tmux", "headless"] as const;
export const terminalSchema = z.enum(TERMINAL_IDS);
export type TerminalId = z.infer<typeof terminalSchema>;

export const agentConfigSchema = z.object({
  /** Which built-in agent to launch; see src/agents/agents.ts for the registry. */
  id: z.string().default("claude"),
  /** Override the executable; empty means the agent's default. */
  command: z.string().default(""),
  /** Extra flags placed before the prompt. */
  args: z.array(z.string()).default([]),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const settingsSchema = z.object({
  /** Parent directory that holds every generated worktree. */
  worktreesRoot: z.string().default(defaultWorktreesRoot()),
  /** Which terminal sessions open in; see src/terminals/registry.ts. */
  terminal: terminalSchema.default("warp"),
  /**
   * How to open Warp. `auto` tries a tab config, then a launch config, then a
   * plain new tab, until the agent starts. The others put that strategy first;
   * `new_tab` only sets the directory and leans on the shell hook.
   */
  warpStrategy: warpStrategySchema.default("auto"),
  /** Use the Warp Preview build (warppreview:// scheme). */
  warpPreview: z.boolean().default(false),
  /**
   * The tmux session new windows go into. Empty means whichever session was
   * used last, or a detached `sidequest` session when no server is running.
   */
  tmuxSession: z.string().default(""),
  /** Which coding agent to launch; command/args override its defaults. */
  agent: agentConfigSchema.default({}),
  /** Pull the base branch before cutting the worktree. */
  fetchBeforeCreate: z.boolean().default(true),
  /** How many messages of surrounding thread context to include. */
  threadContextLimit: z.number().int().min(0).max(50).default(10),
  /**
   * Where to look for checkouts to suggest when linking a channel. Empty means
   * the usual places: ~/code, ~/src, ~/Developer, ~/projects and friends.
   */
  repoSearchRoots: z.array(z.string()).default([]),
  /** Delete the worktree's branch too when running `sidequest clean`. */
  pruneBranchesOnClean: z.boolean().default(true),
  /**
   * Let the running daemon remove finished worktrees on its own, by the same
   * rules as `sidequest clean` (never uncommitted or unmerged work). Off by
   * default: deleting directories unasked should be something you opt into;
   * until then `status` and `doctor` say when finished worktrees pile up.
   */
  autoClean: z.boolean().default(false),
  /**
   * How long a merged worktree must go untouched before autoClean removes it.
   * Sessions that commit nothing count as merged the moment they start, so
   * this is what keeps an Investigate you are still reading from vanishing.
   * A week clears what is really done and outlasts any weekend.
   */
  autoCleanAfterDays: z.number().min(0).max(365).default(7),

  /**
   * DevTools port Slack is launched with. Slack only accepts the flag at
   * process start, so changing this means restarting Slack.
   */
  cdpPort: z.number().int().min(1024).max(65_535).default(9222),
  /**
   * While Sidequest is running, relaunch a Slack that was opened without the
   * DevTools port (from the Dock, Spotlight or login items) so the overlay
   * survives Slack being quit and reopened.
   */
  relaunchSlack: z.boolean().default(true),
  /** Which DevTools targets count as a Slack window. */
  targetUrlPattern: z.string().default("app\\.slack\\.com|/client/"),
  /**
   * Post a short reply as you in the thread of the message a session starts
   * from ("Investigating this."), so whoever asked knows it is being handled.
   * Each prompt's `reply` sets the text.
   */
  autoReply: z.boolean().default(false),
  /**
   * Ask the agent to leave a reply for the thread in .sidequest/result.md
   * when it is done, and offer it (or post it) in Slack. See postResultsSchema.
   */
  postResults: postResultsSchema.default("ask"),
  /**
   * Follow each session's progress (commits, pull request, merged) and show
   * it on the message it came from. Needs `gh` for the pull request part.
   */
  trackStatus: z.boolean().default(true),
  /** Log what the injected overlay is doing to the Slack devtools console. */
  verbose: z.boolean().default(false),
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
  /** Empty turns the thread reply off for this prompt alone. */
  reply: z.string().optional(),
  /** Leave the prompt out of the menu, e.g. a built-in you never use. */
  hidden: z.boolean().optional(),
});

export type PromptOverride = z.infer<typeof promptOverrideSchema>;

export const configSchema = z.object({
  version: z.literal(1).default(1),
  settings: settingsSchema.default({}),
  /**
   * Lowercased channel name -> the repos it is linked to, the default first.
   * Configs from before a channel could hold more than one stored a single
   * link here; those are read as a list of one.
   */
  channels: z
    .record(
      z.string(),
      z.preprocess(
        (value) => (Array.isArray(value) || value === undefined ? value : [value]),
        z.array(repoLinkSchema),
      ),
    )
    .default({}),
  /**
   * Per-prompt overrides of the built-in defaults, keyed by the built-in's
   * key, plus prompts of your own under any other key. A prompt of your own
   * has no default to fall back on, so it needs a label and a template.
   */
  prompts: z
    .record(z.string(), promptOverrideSchema)
    .superRefine((prompts, ctx) => {
      for (const [key, prompt] of Object.entries(prompts)) {
        if ((PROMPT_KEYS as readonly string[]).includes(key)) continue;
        if (!PROMPT_KEY_PATTERN.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "a prompt's key must be lowercase letters, digits and dashes",
          });
        }
        for (const field of ["label", "template"] as const) {
          if (prompt[field] === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key, field],
              message: `a prompt of your own needs a ${field}`,
            });
          }
        }
      }
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
