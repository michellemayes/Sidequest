# Sidequest

An overlay for the Slack desktop app that turns any message into a Claude Code session.

Assign a repo to a channel. Then hover any message in that channel, click
**Sidequest**, and pick **Investigate**, **Fix** or **Review**. Sidequest cuts a
fresh git worktree off your base branch, writes a prompt built from the message
and its thread, and opens the worktree in Warp with Claude Code already running.

Everything runs on your own machine. Nothing is sent anywhere — the message text
goes straight from Slack's renderer into a prompt file in the worktree.

```
hover a message  ──▶  git worktree  ──▶  Warp tab  ──▶  claude "<prompt>"
  Sidequest ▾          fix/checkout-…     "Fix · storefront"
   Investigate
   Fix
   Review
```

## How it attaches to the desktop app

Slack's desktop app is Electron, so its renderer speaks the Chrome DevTools
Protocol. `sidequest start` launches Slack with `--remote-debugging-port`, attaches
over CDP, and injects [`client/inject.js`](client/inject.js) into every Slack
window. That is a real DOM overlay: the buttons are Sidequest's own elements sitting
in Slack's message list.

There is no Slack app to create, no bot token, no workspace install and no
network hop. The trade-off is that Slack only accepts the debug flag at process
start, so Sidequest has to be the thing that launches Slack.

## Requirements

- macOS (the launcher drives `Slack.app`)
- Node.js 20 or newer
- git
- [Warp](https://www.warp.dev/)
- [Claude Code](https://claude.com/claude-code) on your `PATH` as `claude`

## Install

```bash
git clone https://github.com/michellemayes/CCSlackAssist.git
cd CCSlackAssist
npm install
npm run build
npm link              # puts `sidequest` on your PATH
Sidequest init          # creates ~/.Sidequest/config.json
Sidequest install-hook  # so Claude starts when the Warp tab opens
```

## Run it

```bash
Sidequest start          # launches Slack with the overlay attached
Sidequest start --force  # quits an already-running Slack first
```

Leave it running. In Slack:

1. Open a channel and click **Link a repo** in the channel header. Paste an
   absolute path to a git checkout.
2. Hover any message → **Sidequest** → **Investigate** / **Fix** / **Review**.

A Warp tab opens on a new worktree with Claude Code already working. The result —
the branch name, or what went wrong — appears under the message you clicked.

Stopping Sidequest leaves Slack running; the overlay disappears on Slack's next
reload.

### The shell hook

Warp has [ignored `exec` commands from `warp://launch/` deeplinks](https://github.com/warpdotdev/warp/issues/9007)
in some versions. `sidequest install-hook` adds one line to your `~/.zshrc` that
starts the session when a shell opens in a Sidequest worktree. It is safe alongside
the launch config — whichever fires first claims the session, and the other exits
quietly.

## CLI

| Command | What it does |
| --- | --- |
| `sidequest start` | Launch Slack with the overlay attached. `--force` |
| `sidequest doctor` | Check git, Warp, Claude Code, Slack.app and the debug port |
| `sidequest list` | Show settings and linked channels |
| `sidequest sessions` | List every worktree Sidequest created |
| `sidequest clean` | Remove worktrees whose branch is merged. `--all`, `--force` |
| `sidequest prompts` | Print the three prompt templates |
| `sidequest install-hook` | Install the shell hook. `--print`, `--rc <path>` |
| `sidequest link <path> -c <channel>` | Link from the terminal, by channel name |
| `sidequest unlink -c <channel>` | Remove a link |

`sidequest clean` never destroys work: it leaves a branch alone if it holds
unmerged commits, and refuses a worktree with uncommitted changes unless you pass
`--force`.

## The three prompts

| | Branch | What it asks for |
| --- | --- | --- |
| **Investigate** | `investigate/…` | Reproduce, trace to the responsible code, explain the mechanism, recommend a fix. Changes nothing. |
| **Fix** | `fix/…` | Root-cause it, make the smallest fix, add a failing-then-passing test, get lint and tests green, commit. |
| **Review** | `review/…` | Review the referenced PR, branch or diff for real bugs first, then clarity. Changes nothing. |

Each prompt receives the message text, up to ten preceding messages, the sender,
the channel, a permalink, and the branch it is working on.

### Customising them

Edit the `prompts` section of `~/.sidequest/config.json`. Anything you leave out
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

Run `sidequest prompts` to see the current set. The button labels come from `label`,
so renaming a prompt renames it in the menu.

## Settings

`~/.sidequest/config.json`, under `settings`:

| Setting | Default | What it does |
| --- | --- | --- |
| `worktreesRoot` | `~/.sidequest/worktrees` | Where worktrees are created |
| `warpStrategy` | `launch_config` | `launch_config`, `tab_config` or `new_tab` |
| `warpPreview` | `false` | Use Warp Preview (`warppreview://`) |
| `claudeCommand` | `claude` | The Claude Code executable |
| `claudeArgs` | `[]` | Extra flags, e.g. `["--model", "opus"]` |
| `fetchBeforeCreate` | `true` | Fetch the base branch before branching |
| `threadContextLimit` | `10` | Preceding messages included in the prompt |
| `pruneBranchesOnClean` | `true` | Also delete merged branches on `clean` |
| `cdpPort` | `9222` | DevTools port Slack is launched with |
| `targetUrlPattern` | `app\.slack\.com\|/client/` | Which windows count as Slack |
| `verbose` | `false` | Log overlay activity to Slack's devtools console |

Channels are keyed by name, lowercased and without the `#`, because the channel
name is what the overlay can read off the DOM.

## How a session is built

1. The overlay reads the message, its sender, its permalink and the preceding
   messages out of Slack's DOM, and sends them to the local daemon.
2. The channel's repo is resolved and the base branch detected (`origin/HEAD`,
   then `main`/`master`/`develop`, then the current branch).
3. `git worktree add -b <branch> <path> origin/<base>` — a real branch, isolated
   from whatever you have checked out.
4. The prompt is rendered into `<worktree>/.sidequest/prompt.md`, alongside a
   run-once `autorun.sh`.
5. `.sidequest/` is added to the repo's `.git/info/exclude`, so Claude never sees
   the prompt files as untracked changes and `sidequest clean` can remove the
   worktree later.
6. Warp is opened on the worktree and `autorun.sh` starts Claude Code.

Branch names look like `fix/checkout-total-is-wrong-20260909-1432`. Clicking the
same message twice gives you `-2`, `-3` rather than an error.

## Troubleshooting

**"Slack is running without --remote-debugging-port".** Slack only accepts the
flag at startup. Quit Slack, or run `sidequest start --force` to have Sidequest
restart it.

**No buttons in Slack.** Check the terminal running `sidequest start` — it prints a
line per attached window. If it attached but nothing shows, Slack may have
changed its `data-qa` attributes; set `verbose: true` and check Slack's devtools
console.

**"No repo is linked to #channel".** Click **Link a repo** in the channel header.

**Warp opens but Claude doesn't start.** Run `sidequest install-hook`, then open a
new terminal.

**Warp doesn't open at all.** Sidequest still creates the worktree and says so under
the message — `cd` there and run `.sidequest/autorun.sh`.

**`sidequest clean` skips everything.** Those worktrees have uncommitted changes.
Check with `sidequest sessions`, then use `--force` once you're sure.

## Development

```bash
npm run dev -- doctor   # run from source
npm test                # 47 tests
npm run typecheck
```

The test suite includes integration tests that create real git worktrees and
execute the generated `autorun.sh`, plus end-to-end tests that launch headless
Chromium, inject the real overlay over CDP against a Slack-shaped fixture, and
click through to a real worktree. Chromium stands in for Slack's Electron
renderer — the same engine, driven the same way. Those tests skip themselves if
no Chromium is found.

## Security notes

- The overlay only reads the DOM of Slack windows and only talks to the local
  daemon over the CDP binding. It makes no network requests.
- Commands are executed with an argv array, never through a shell, so message
  text cannot inject shell syntax. The generated `autorun.sh` single-quotes every
  interpolated value, and the prompt is passed via a file rather than the command
  line.
- The DevTools port is bound to `127.0.0.1`. Anything running as your user on
  your machine can talk to it while Slack is running that way — the same
  exposure any Electron app with remote debugging enabled has.

## License

MIT
