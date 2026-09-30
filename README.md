# <img src="assets/icon.svg" width="48" height="48" align="top" alt="Sidequest icon"> Sidequest

**Turn any Slack message into a coding-agent session in one click.**

Someone reports a bug in Slack. You hover the message and click **Sidequest → Fix**.
A few seconds later a Warp tab is open on a fresh git worktree, and Claude Code (or
Codex) is already working on it, with the message and its thread as the prompt.

![Sidequest demo: hover a Slack message, pick Fix, and get a branch back](docs/demo/demo.gif)

<sub>The overlay running over a mock channel. See [`docs/demo`](docs/demo) to re-record it.</sub>

- **No Slack app, no bot token, no workspace install.** Sidequest attaches to the
  Slack desktop app you already use.
- **Nothing leaves your machine.** The message goes from Slack's window into a
  prompt file on disk.
- **Your checkout is never touched.** Every session gets its own branch and
  worktree, cut from an up-to-date base branch.

## Quick start

You'll need macOS, Node 20+, git, [Warp](https://www.warp.dev/), and
[Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex)
on your `PATH`.

```bash
git clone https://github.com/michellemayes/Sidequest.git
cd Sidequest
npm install && npm run build && npm link
sidequest setup          # config, shell hook, checks, then relaunches Slack with the overlay
```

`setup` runs `init`, `install-hook`, `doctor` and `start` in turn, and is safe to
run again. Then, in Slack:

1. Hover any message → **Sidequest**. In a channel with no repo yet, the menu
   suggests the checkouts on your machine that match the channel's name (for
   `#storefront-eng`, that's `storefront`). One click links it and shows the prompts.
2. Pick **Investigate**, **Fix** or **Review**, or press **1**/**2**/**3**
   (or **I**/**F**/**R**).

A toast confirms the launch with your running count, today's count and your
day streak. The branch name, or the error if something went wrong, shows up
under the message; click it to reopen the session, or **×** to dismiss it.

Messages you've already started a session from keep a small **✦ Fix** mark.
Click it to jump back into that session. Its menu also leads with **Back to Fix**,
so you don't cut a duplicate branch by accident.

| | What the agent does |
| --- | --- |
| **Investigate** | Reproduces the problem, traces it to the code, explains it and recommends a fix. Changes nothing. |
| **Fix** | Finds the root cause, makes the smallest fix, adds a test, gets lint and tests passing, and commits. |
| **Review** | Reviews the referenced PR, branch or diff, bugs first. Changes nothing. |

## How it works

Slack's desktop app is built on Electron. `sidequest start` launches it with
`--remote-debugging-port` and injects a small overlay
([`client/inject.js`](client/inject.js)) over the Chrome DevTools Protocol. The
overlay reads the message, its thread, the sender and the permalink from the page,
and a local daemon then:

1. creates `git worktree add -b <branch> <path> origin/<base>`,
2. writes the prompt to `<worktree>/.sidequest/prompt.md` (git-excluded),
3. opens Warp on the worktree and starts your agent.

<img src="docs/demo/menu.png" width="720" alt="The Sidequest menu open on a message, with Investigate, Fix and Review">

The overlay sits in its own shadow-DOM layer and never modifies Slack's DOM. It
picks up your Slack theme and moves out of the way of Slack's own buttons.

## CLI

| Command | What it does |
| --- | --- |
| `sidequest setup` | First run in one command: config, shell hook, checks, start |
| `sidequest start` / `stop` / `status` | Run the background daemon (logs in `~/.sidequest/sidequest.log`) |
| `sidequest doctor` | Check git, Warp, the agent, Slack.app and the debug port |
| `sidequest sessions` | List every worktree Sidequest created |
| `sidequest reopen [ref]` | Reopen Warp on a session (the latest if you name none) |
| `sidequest stats` | Your total, today's count, current and best streak |
| `sidequest clean` | Remove merged worktrees. It won't delete uncommitted work unless you pass `--force` |
| `sidequest link <path> -c <channel>` / `unlink` | Link or unlink a channel from the terminal |
| `sidequest list` / `prompts` / `agents` | Show linked channels, prompt templates and available agents |

## Configuration

Everything lives in `~/.sidequest/config.json`.

**Prompts.** Override any of the three templates or labels. Anything you leave out
keeps its default:

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

Tokens: `{{author}}` `{{channel}}` `{{message}}` `{{thread}}` `{{permalink}}`
`{{date}}` `{{branch}}` `{{baseBranch}}` `{{repo}}` `{{worktree}}`. Sidequest
leaves unknown tokens in the prompt as written, so typos are easy to spot.

**Settings** (under `settings`):

| Setting | Default | |
| --- | --- | --- |
| `agent` | `{ "id": "claude" }` | `claude` or `codex`. Use `command`/`args` to override the executable |
| `worktreesRoot` | `~/.sidequest/worktrees` | Where worktrees go |
| `warpStrategy` | `launch_config` | `launch_config`, `tab_config` or `new_tab` |
| `warpPreview` | `false` | Use Warp Preview |
| `fetchBeforeCreate` | `true` | Fetch the base branch first |
| `repoSearchRoots` | `[]` | Where to look for repos to suggest. Empty means `~/code`, `~/src`, `~/Developer`, `~/projects` and similar, two levels deep |
| `threadContextLimit` | `10` | How many earlier messages go into the prompt |
| `pruneBranchesOnClean` | `true` | Delete merged branches on `clean` |
| `cdpPort` | `9222` | DevTools port for Slack |
| `relaunchSlack` | `true` | While Sidequest runs, relaunch a Slack reopened from the Dock (without the DevTools port) so the overlay comes back |
| `targetUrlPattern` | `app\.slack\.com\|/client/` | Which windows count as Slack |
| `verbose` | `false` | Log overlay activity to Slack's devtools console |

## Troubleshooting

Start with `sidequest doctor`.

- **"Slack is running without --remote-debugging-port"**: Slack only accepts
  the flag at launch. Run `sidequest start --force`.
- **The overlay is gone after quitting and reopening Slack**: a Slack opened
  from the Dock has no DevTools port, so the running daemon quits it and
  relaunches it with the port within a couple of seconds. If that doesn't
  happen, check `sidequest status` (the daemon has to be running) and the log.
- **No buttons**: hover a message first. If `sidequest status` shows zero
  attached windows, the overlay wasn't injected.
- **"Something other than Slack is listening on 127.0.0.1:9222"**: quit that
  app, or set `cdpPort` to a free port and run `start --force`.
- **The repo I want isn't suggested**: add its parent folder to
  `repoSearchRoots`, or paste the path into the channel pill's panel.
- **Warp opens but the agent doesn't start**: run `sidequest install-hook` and
  open a new terminal, or run `sidequest reopen` (latest) / `sidequest reopen <branch>`.
- **Warp doesn't open**: the worktree still exists. `cd` into it and run
  `.sidequest/autorun.sh`.

## Security

The overlay makes no network requests and only talks to the local daemon.
Sidequest runs commands from argv arrays, never through a shell, and passes the
prompt in a file, so message text can't inject commands. The overlay runs inside
Slack's window, so what the daemon sends it is visible there: channel links,
prompt labels, past sessions' branch names, and (only while a link menu or panel
is open) the paths of the repos it suggests. Session history is kept in
`~/.sidequest/history.json`. The DevTools port is
bound to `127.0.0.1`, which means other processes running as your user can reach
it, as with any Electron app that has remote debugging on.

## Development

```bash
npm run dev -- doctor   # run from source
npm test                # unit, git integration, and headless-Chromium e2e tests
npm run typecheck
```

## License

MIT
