# ccslack

Turn any Slack message into a Claude Code session.

Assign a repo to a Slack channel. Then, from any message in that channel, pick
**Investigate**, **Fix** or **Review**. ccslack cuts a fresh git worktree off your
base branch, writes a prompt built from the message and its thread, and opens
the worktree in Warp with Claude Code already running on it.

Everything runs on your own machine. Slack message content never leaves your
laptop — it goes straight into a prompt file in the worktree.

```
Slack message  ──▶  git worktree  ──▶  Warp tab  ──▶  claude "<prompt>"
   ⋮ → Fix          fix/checkout-…      "Fix · storefront"
```

## Why it works with the Slack desktop app

The buttons are Slack **message shortcuts**, which show up in every message's
`⋮` (More actions) menu in the desktop app, the web app and mobile alike. There
is no browser extension to install and nothing to patch.

The app connects to Slack in **Socket Mode**: it dials out over a WebSocket from
your laptop, so no public URL, tunnel or hosting is needed — and it can create
worktrees and launch Warp locally, which a hosted Slack app could never do.

## Requirements

- Node.js 20 or newer
- git
- [Warp](https://www.warp.dev/)
- [Claude Code](https://claude.com/claude-code) on your `PATH` as `claude`
- Permission to create a Slack app in your workspace

## Install

```bash
git clone https://github.com/michellemayes/CCSlackAssist.git
cd CCSlackAssist
npm install
npm run build
npm link          # puts `ccslack` on your PATH
ccslack init      # creates ~/.ccslack/config.json and ~/.ccslack/.env
```

## Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace and paste [`manifest/slack-app-manifest.yaml`](manifest/slack-app-manifest.yaml).
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**. Give it
   the `connections:write` scope. Copy the `xapp-…` token.
4. **Install App** → install to your workspace. Copy the `xoxb-…` **Bot User OAuth Token**.
5. Put both in `~/.ccslack/.env`:

   ```
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_APP_TOKEN=xapp-…
   ```

6. Check everything is wired up:

   ```bash
   ccslack doctor
   ```

## Run it

```bash
ccslack start
```

Leave it running. Then in Slack:

1. Invite the bot to a channel: `/invite @ccslack`
2. Link the channel to a repo: `/ccslack link ~/code/storefront`
3. On any message, open `⋮` → **Fix** (or **Investigate** / **Review**).

A Warp tab opens on a new worktree with Claude Code already working.

### The shell hook

Warp has [ignored `exec` commands from `warp://launch/` deeplinks](https://github.com/warpdotdev/warp/issues/9007)
in some versions. To make sessions start regardless:

```bash
ccslack install-hook
```

This adds one line to your `~/.zshrc` (or `~/.bashrc`) that starts the session
when a shell opens in a ccslack worktree. It is safe alongside the launch
config — whichever fires first claims the session, and the other exits quietly.

## Slack commands

| Command | What it does |
| --- | --- |
| `/ccslack link <path>` | Link this channel to a repo. `--base <branch>`, `--label <name>` |
| `/ccslack unlink` | Remove this channel's link |
| `/ccslack status` | Show what this channel is linked to |
| `/ccslack list` | List every linked channel |
| `/ccslack sessions` | Live worktrees for this channel's repo |

Replies are ephemeral — only you see them.

## CLI

| Command | What it does |
| --- | --- |
| `ccslack start` | Connect to Slack and listen |
| `ccslack doctor` | Check git, Warp, Claude Code, tokens and links |
| `ccslack list` | Show settings and linked channels |
| `ccslack sessions` | List every worktree ccslack created |
| `ccslack clean` | Remove worktrees whose branch is merged. `--all`, `--force` |
| `ccslack prompts` | Print the three prompt templates |
| `ccslack install-hook` | Install the shell hook. `--print`, `--rc <path>` |
| `ccslack link <path> -c <channel-id>` | Link from the terminal |

`ccslack clean` never destroys work: it leaves a branch alone if it holds
unmerged commits, and refuses a worktree with uncommitted changes unless you
pass `--force`.

## The three prompts

| | Branch | What it asks for |
| --- | --- | --- |
| 🔍 **Investigate** | `investigate/…` | Reproduce, trace to the responsible code, explain the mechanism, recommend a fix. Changes nothing. |
| 🔧 **Fix** | `fix/…` | Root-cause it, make the smallest fix, add a failing-then-passing test, get lint and tests green, commit. |
| 👀 **Review** | `review/…` | Review the referenced PR, branch or diff for real bugs first, then clarity. Changes nothing. |

Each prompt receives the message text, the thread, the author, the channel, a
permalink, and the branch it is working on.

### Customising them

Edit the `prompts` section of `~/.ccslack/config.json`. Anything you leave out
falls back to the built-in default, so you can override just the template:

```json
{
  "prompts": {
    "fix": {
      "label": "Patch",
      "template": "Fix this, reported by @{{author}} in #{{channel}}:\n{{message}}\n\nCommit on {{branch}}."
    }
  }
}
```

Available tokens: `{{author}}`, `{{channel}}`, `{{message}}`, `{{thread}}`,
`{{permalink}}`, `{{date}}`, `{{branch}}`, `{{baseBranch}}`, `{{repo}}`,
`{{worktree}}`. An unknown token is left visible in the prompt rather than
silently blanked, so typos are obvious.

Run `ccslack prompts` to see the current set.

## Settings

`~/.ccslack/config.json`, under `settings`:

| Setting | Default | What it does |
| --- | --- | --- |
| `worktreesRoot` | `~/.ccslack/worktrees` | Where worktrees are created |
| `warpStrategy` | `launch_config` | `launch_config`, `tab_config` or `new_tab` |
| `warpPreview` | `false` | Use Warp Preview (`warppreview://`) |
| `claudeCommand` | `claude` | The Claude Code executable |
| `claudeArgs` | `[]` | Extra flags, e.g. `["--model", "opus"]` |
| `fetchBeforeCreate` | `true` | Fetch the base branch before branching |
| `threadContextLimit` | `10` | Thread replies to include in the prompt |
| `pruneBranchesOnClean` | `true` | Also delete merged branches on `clean` |

`launch_config` and `tab_config` give a titled, coloured tab. `new_tab` only
opens the folder and relies on the shell hook. If the preferred strategy fails,
ccslack falls back to `new_tab` automatically.

## How a session is built

1. The channel's repo is resolved and the base branch detected (`origin/HEAD`,
   then `main`/`master`/`develop`, then the current branch).
2. `git worktree add -b <branch> <path> origin/<base>` — a real branch, isolated
   from whatever you have checked out.
3. The prompt is rendered into `<worktree>/.ccslack/prompt.md`, alongside a
   run-once `autorun.sh`.
4. `.ccslack/` is added to the repo's `.git/info/exclude`, so Claude never sees
   the prompt files as untracked changes and `ccslack clean` can remove the
   worktree later.
5. Warp is opened on the worktree and `autorun.sh` starts Claude Code.

Branch names look like `fix/checkout-total-is-wrong-20260909-1432`. Clicking the
same message twice gives you `-2`, `-3` rather than an error.

## Troubleshooting

**Nothing happens when I click.** Check the terminal running `ccslack start`.
The most common cause is the bot not being in the channel — `/invite @ccslack`.

**"No repo is linked to #channel".** Run `/ccslack link ~/path/to/repo` there.

**Warp opens but Claude doesn't start.** Run `ccslack install-hook`, then open a
new terminal.

**Warp doesn't open at all.** ccslack still creates the worktree and tells you
the path — `cd` there and run `.ccslack/autorun.sh`. Check Warp is installed and
registered for `warp://` links.

**`ccslack clean` skips everything.** Those worktrees have uncommitted changes.
Check with `ccslack sessions`, then use `--force` once you're sure.

## Development

```bash
npm run dev -- doctor   # run from source
npm test                # 50 tests, including real git worktree integration tests
npm run typecheck
```

## Security notes

- Both tokens live in `~/.ccslack/.env` (mode `600`) and are never logged.
- Commands are executed with an argv array, never through a shell, so message
  text cannot inject shell syntax. The generated `autorun.sh` single-quotes
  every interpolated value, and the prompt is passed via a file rather than the
  command line.
- The bot only requests the scopes in the manifest; it posts ephemerally and
  never writes to a channel.

## License

MIT
