# <img src="assets/icon.svg" width="48" height="48" align="top" alt="Sidequest icon"> Sidequest

**Turn any Slack message into a coding-agent session in one click.**

Someone reports a bug in Slack. You hover the message and click **Sidequest → Fix**.
A few seconds later a terminal tab is open on a fresh git worktree, and Claude Code (or
Codex) is already working on it, with the message and its thread as the prompt.
That's Warp out of the box; iTerm2, Ghostty, Terminal and tmux work too, or skip the
terminal and let the agent run in the background, or open the session in the Claude or
ChatGPT desktop app instead.

![Sidequest demo: pick Fix on a Slack message, watch Claude Code fix it in a Warp tab on a new worktree, and find the branch linked back in Slack](docs/demo/demo.gif)

<sub>End to end: the real overlay running over a mock of the Slack desktop app, then the Warp
tab it opens with Claude Code finding, testing and committing the fix on the new branch, then
the branch linked back under the message. The Slack window and the terminal session are staged
for the recording; see [`docs/demo`](docs/demo) to re-record it.</sub>

- **No Slack app, no bot token, no workspace install.** Sidequest attaches to the
  Slack desktop app you already use.
- **Nothing leaves your machine.** The message goes from Slack's window into a
  prompt file on disk. (Unless you turn on thread replies, which post to Slack as you.)
- **Your checkout is never touched.** Every session gets its own branch and
  worktree, cut from an up-to-date base branch.

## Quick start

You'll need macOS, Node 20+, git, and one of:

- [Claude Code](https://claude.com/claude-code) or
  [Codex](https://github.com/openai/codex) on your `PATH`. Sessions open in
  [Warp](https://www.warp.dev/) unless you pick another terminal (see
  [Terminals](#terminals)), or
- the [Claude desktop app](https://claude.com/download) or the
  [ChatGPT desktop app](https://chatgpt.com/download) (see [Desktop apps](#desktop-apps)).

```bash
git clone https://github.com/michellemayes/Sidequest.git
cd Sidequest
npm install && npm run build && npm link
sidequest setup          # config, shell hook, checks, then relaunches Slack with the overlay
```

`setup` runs `init`, `install-hook`, `doctor` and `start` in turn, and is safe to
run again.

**Updating** is one command, from anywhere:

```bash
sidequest update
```

It pulls the latest, runs `npm ci` only when `package.json` or
`package-lock.json` changed (most updates skip it), builds into a scratch folder
and swaps it in only if the build succeeds, and restarts the daemon if it was
running. When there's nothing new to pull, it still restarts a daemon that is
running an older build (say, after an earlier `--no-restart`). If anything fails, the checkout goes back to the version you had, so a
bad update never leaves you with a broken install. It refuses to run over local
edits in the checkout. Then, in Slack:

1. Hover any message → **Sidequest**. In a channel with no repo yet, the menu
   suggests the checkouts on your machine that match the channel's name (for
   `#storefront-eng`, that's `storefront`). One click links it and shows the prompts.
2. Pick **Investigate**, **Fix**, **Review** or **Ask**, or press **1**–**4**
   (or **I**/**F**/**R**/**A**).

A channel can have more than one repo. Add another from the repo button beside
the channel name (it lists the channel's repos, each with **×** to unlink it),
or with `sidequest link`. The menu then shows a row of the channel's repos above
the prompts: click one, or press **←**/**→**, to pick where the session runs.
It opens on the repo the channel's last session used.

A toast confirms the launch with your running count, today's count and your
day streak. The branch name, or the error if something went wrong, shows up
under the message; click it to reopen the session, or **×** to dismiss it.

Messages you've already started a session from keep a small **✦ Fix** mark.
Click it to jump back into that session. Its menu also leads with **Back to Fix**,
so you don't cut a duplicate branch by accident.

Press **⌃⇧S** anywhere in Slack (or click **Sessions ›** in the repo button's
panel) for your recent sessions that still have a worktree, newest first. Each
shows its branch, the prompt, repo and channel it came from, how long ago, and
what git says about it: commits the base doesn't have yet, uncommitted files,
whether the agent has started, or that the worktree was deleted. Click one (or
**↑**/**↓** and **Enter**) to reopen it in your terminal or agent app (headless, to open its
answer). **×** (or **Delete**) removes a
finished one by the same rules as `sidequest clean`: the branch stays if it has
unmerged commits, and a worktree with uncommitted changes is only removed once
you've been told how many and clicked **Discard and remove**.

| | What the agent does |
| --- | --- |
| **Investigate** | Reproduces the problem, traces it to the code, explains it and recommends a fix. Changes nothing. |
| **Fix** | Finds the root cause, makes the smallest fix, adds a test, gets lint and tests passing, and commits. |
| **Review** | Reviews the referenced PR, branch or diff, bugs first. Changes nothing. |
| **Ask** | Opens a small box in the menu for your question (**Enter** to send, **Shift+Enter** for a new line, **Esc** to cancel). The agent gets the message, the thread and your question, reads the relevant code, and answers it. Send it empty and the agent just reads and waits for you. |
| **Linear** | Only on a message that links a Linear issue, and named for it (**Linear DATA-3051**). Reads the ticket, fixes it, and commits with the issue ID on a `linear/data-3051-…` branch, so Linear links the branch back. |
| **GitHub** | Only on a message that links a GitHub issue (**GitHub #123**). Reads it (with `gh issue view` when it can), fixes it, and commits on an `issue/123-…` branch with `Fixes owner/repo#123`, so merging closes the issue. |
| **Jira** | Only on a message that links a Jira ticket, on Jira Cloud or your own server (**Jira ABC-123**). Reads it, fixes it, and commits with the key on a `jira/ABC-123-…` branch, so Jira's development panel picks both up. |

A message that links more than one ticket gets a prompt for each of the first
two, in the order they appear. Only full links count: a bare `#123` could be
any repo's.

## How it works

Slack's desktop app is built on Electron. `sidequest start` launches it with
`--remote-debugging-port` and injects a small overlay
([`client/inject.js`](client/inject.js)) over the Chrome DevTools Protocol. The
overlay reads the message, its thread, the sender and the permalink from the page,
and a local daemon then:

1. creates `git worktree add -b <branch> <path> origin/<base>`,
2. writes the prompt to `<worktree>/.sidequest/prompt.md` (git-excluded),
3. opens your terminal on the worktree and starts your agent (or, headless,
   runs it in the background, or opens your agent's desktop app there, see
   [Desktop apps](#desktop-apps)).

### Desktop apps

Sessions don't have to open in a terminal. Two agents live in desktop apps instead:

```bash
sidequest agents claude-desktop   # Claude Code in the Claude app
sidequest agents chatgpt          # Codex in the ChatGPT app
sidequest agents claude           # back to Claude Code in your terminal
```

The worktree, branch and prompt are made exactly as before. Then, instead of a
terminal, Sidequest opens the app with a deep link
([`claude://code/new`](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link),
[`codex://threads/new`](https://learn.chatgpt.com/docs/reference/commands)): a new
session in the worktree with the prompt already in the composer. Press **Enter**
there to start it. Claude asks you to trust the folder the first time. A prompt too
long for a link (over 12,000 characters) is left in `.sidequest/prompt.md`, and the
composer asks the agent to read it.

Reopening a session (`sidequest reopen`, or **Back to Fix** in Slack) starts a new
session in the app on the same worktree; the links can't reach back into an earlier
one. The `terminal` setting (headless included), the shell hook, `warpStrategy` and
`warpPreview` only matter for the terminal agents.

<img src="docs/demo/menu.png" width="720" alt="The Sidequest menu open on a message, with Investigate, Fix and Review">

The overlay sits in its own shadow-DOM layer and never modifies Slack's DOM. It
picks up your Slack theme and moves out of the way of Slack's own buttons.

## CLI

| Command | What it does |
| --- | --- |
| `sidequest setup` | First run in one command: config, shell hook, checks, start |
| `sidequest start` / `stop` / `status` | Run the background daemon (logs in `~/.sidequest/sidequest.log`) |
| `sidequest update` | Pull the latest and rebuild, reinstalling dependencies only if they changed; restarts a running daemon (`--no-restart` to skip) |
| `sidequest doctor` | Check git, your terminal, the agent, Slack.app, the debug port, and whether the build is current |
| `sidequest sessions` | List every worktree Sidequest created (in Slack, **⌃⇧S** shows your recent ones) |
| `sidequest reopen [ref]` | Reopen a session's terminal (the latest if you name none). Headless, it opens the answer, or the log while it's still running |
| `sidequest stats` | Your total, today's count, current and best streak |
| `sidequest clean` | Remove merged worktrees. It won't delete uncommitted work unless you pass `--force`. Turn on `autoClean` and the daemon does this for you |
| `sidequest link <path> -c <channel>` | Link a repo to a channel from the terminal. Linking a second repo adds it; the first stays the default |
| `sidequest unlink [repo] -c <channel>` | Unlink one repo (by path or label) from a channel, or all of them if you name none |
| `sidequest replies [on\|off]` | Show the thread replies sessions post, or turn them on or off |
| `sidequest agents [claude\|codex\|claude-desktop\|chatgpt]` | Show the available agents, or switch the one new sessions use |
| `sidequest terminal [name]` | Show the terminals sessions can open in, or switch: `warp`, `iterm2`, `ghostty`, `terminal`, `tmux` or `headless` |
| `sidequest list` / `prompts` | Show linked channels and prompt templates |

## Terminals

Sessions open in Warp unless you say otherwise. Switch with
`sidequest terminal <name>` (a running daemon picks it up on the next click),
and run `sidequest doctor` to check the new one works. The desktop-app agents
(`claude-desktop`, `chatgpt`) always open in their app and ignore this setting:

| | What a session opens |
| --- | --- |
| `warp` (default) | A coloured Warp tab, via a tab config, a launch config or the shell hook. See `warpStrategy` below |
| `iterm2` | A new tab in iTerm2's front window, or a new window if none is open |
| `ghostty` | A new Ghostty window. Needs Ghostty 1.2 or later |
| `terminal` | A new Terminal.app window |
| `tmux` | A new window in your running tmux server (the session you used last, or `tmuxSession`). With no server running, a detached `sidequest` session: `tmux attach -t sidequest` |
| `headless` | No terminal at all. See below |

iTerm2 and Terminal are driven over AppleScript, so the first session makes
macOS ask whether Sidequest may control them. Every terminal runs the same
`.sidequest/autorun.sh` in the worktree, which reads the prompt from its file,
and leaves you a shell there when the agent exits.

**Headless.** `sidequest terminal headless` runs the agent non-interactively in
the background: `claude -p` or `codex exec`, with the prompt as its one
argument. Everything it prints goes to `.sidequest/agent.log` in the worktree,
and its final answer to `.sidequest/result.md` (only when it finishes cleanly).
Nobody is there to approve anything, so each agent runs with limits: Claude
Code may edit files in the worktree (`--permission-mode acceptEdits`) but not
run commands, and Codex runs in its workspace-write sandbox (`--full-auto`).
Your `agent.args` go after those flags. Clicking the session later (or
`sidequest reopen`) opens `result.md`, or `agent.log` while it's still working.

## Configuration

Everything lives in `~/.sidequest/config.json`.

**Prompts.** Override any of the templates or labels. Anything you leave out
keeps its default:

```json
{
  "prompts": {
    "fix": {
      "label": "Patch",
      "template": "Fix this, reported by @{{author}} in #{{channel}}:\n{{message}}\n\nCommit on {{branch}}."
    },
    "github": { "branchPrefix": "gh" },
    "jira": { "template": "Work {{ticketId}} ({{ticket}}) from #{{channel}}:\n{{message}}\n\nPut {{ticketId}} in every commit." }
  }
}
```

The keys are `investigate`, `fix`, `review`, `ask`, `linear`, `github` and `jira`.

Tokens: `{{author}}` `{{channel}}` `{{message}}` `{{thread}}` `{{permalink}}`
`{{date}}` `{{branch}}` `{{baseBranch}}` `{{repo}}` `{{worktree}}`, plus
`{{ticket}}` (the link) and `{{ticketId}}` (`DATA-3051`, `owner/repo#123` or
`ABC-123`) for Linear, GitHub and Jira, and `{{question}}` (what you typed in
the Ask box, empty otherwise). Sidequest
leaves unknown tokens in the prompt as written, so typos are easy to spot.

**Thread replies.** Turn on `autoReply` (or run `sidequest replies on`) and
starting a session also posts a short reply, as you, in the thread of the
message you started it from, so whoever asked knows it's being handled:

| | Default reply |
| --- | --- |
| **Investigate** | Investigating this. |
| **Fix** | Working on a fix. |
| **Review** | Reviewing this. |
| **Ask** | Looking into this: _what you typed in the Ask box_ |
| **Linear** | Picking up DATA-3051. |
| **GitHub** | Picking up owner/repo#123. |
| **Jira** | Picking up ABC-123. |

Each prompt's `reply` sets its text and takes the same tokens as its template
(`{{repo}}` is the repo's label, and `{{question}}` is just what you typed,
without a heading). With nothing typed in the Ask box, its reply is
"Looking into this." An empty `reply` turns it off for that prompt:

```json
{
  "settings": { "autoReply": true },
  "prompts": {
    "fix": { "reply": "On it, fixing this now." },
    "review": { "reply": "" }
  }
}
```

**Settings** (under `settings`):

| Setting | Default | |
| --- | --- | --- |
| `agent` | `{ "id": "claude" }` | `claude` or `codex` in your terminal, or `claude-desktop` or `chatgpt` in their desktop apps (or run `sidequest agents codex`). Use `command`/`args` to override a terminal agent's executable |
| `worktreesRoot` | `~/.sidequest/worktrees` | Where worktrees go |
| `terminal` | `warp` | `warp`, `iterm2`, `ghostty`, `terminal`, `tmux` or `headless` (or run `sidequest terminal <name>`). See Terminals above. Ignored by the desktop-app agents |
| `tmuxSession` | `""` | The tmux session new windows go into. Empty means the one you used last |
| `warpStrategy` | `auto` | Warp only. `auto` tries a tab config, then a launch config, then a plain new tab, until the agent starts. `tab_config`, `launch_config` or `new_tab` puts that one first |
| `warpPreview` | `false` | Warp only. Use Warp Preview |
| `fetchBeforeCreate` | `true` | Fetch the base branch first. A fetch slower than 3 seconds doesn't hold up the session: it's cut from the local ref while the fetch finishes in the background |
| `repoSearchRoots` | `[]` | Where to look for repos to suggest. Empty means `~/code`, `~/src`, `~/Developer`, `~/projects` and similar, two levels deep |
| `threadContextLimit` | `10` | How many earlier messages go into the prompt |
| `pruneBranchesOnClean` | `true` | Delete merged branches on `clean` (and on auto-clean, and when you remove a session from the sessions panel) |
| `autoClean` | `false` | Let the running daemon remove finished worktrees itself. See Cleaning up below |
| `autoCleanAfterDays` | `7` | How long a merged worktree has to sit untouched before auto-clean removes it |
| `cdpPort` | `9222` | DevTools port for Slack |
| `relaunchSlack` | `true` | While Sidequest runs, relaunch a Slack reopened from the Dock (without the DevTools port) so the overlay comes back |
| `targetUrlPattern` | `app\.slack\.com\|/client/` | Which windows count as Slack |
| `autoReply` | `false` | Reply in the message's thread when a session starts. See Thread replies above |
| `verbose` | `false` | Log overlay activity to Slack's devtools console |

**Cleaning up.** Every session leaves a worktree behind. `sidequest clean`
removes the ones whose branch is merged into the base, deleting the branch too
(with `git branch -d`, which refuses one holding commits the base doesn't
have), and never a worktree with uncommitted changes unless you pass `--force`.

Turn on `autoClean` and the running daemon does the same every six hours, by
the same rules, plus one more: it leaves a worktree alone until nothing has
touched it for `autoCleanAfterDays`. Investigate, Review and Ask commit
nothing, so their branch counts as merged the moment it's cut, while you may
still be reading what the agent found. It never fetches, so "merged" means
merged into the base as of your last session's fetch, and it logs what it
removed to `~/.sidequest/sidequest.log`. It's off by default, since deleting
directories should be something you ask for. Until you turn it on,
`sidequest status` counts the finished worktrees, and `doctor` and `start`
mention them once five or more have piled up.

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
- **Warp opens but the agent doesn't start**: Sidequest opens a Warp tab config
  first, which Warp picks up while it's running. Launch configurations, the old
  default, are only read when Warp starts, so a deeplink to one just focuses
  Warp. If neither starts the agent, Sidequest opens a plain tab on the
  worktree, where the shell hook takes over: run `sidequest install-hook` and
  open a new Warp tab. `~/.sidequest/sidequest.log` shows which strategy was
  tried. Then retry, or run `sidequest reopen` (latest) / `sidequest reopen <branch>`.
- **Warp (or your terminal) doesn't open**: the worktree still exists. `cd`
  into it and run `.sidequest/autorun.sh`.
- **iTerm2 or Terminal doesn't open, and the log says "Not authorized"**: macOS
  blocked the AppleScript. Allow Sidequest's terminal (the one you ran
  `sidequest start` from) to control it under System Settings → Privacy &
  Security → Automation, then `sidequest reopen`.
- **A tmux session opened but you can't see it**: with no tmux server running,
  Sidequest starts a detached `sidequest` session. `tmux attach -t sidequest`.
- **Headless: no `result.md`**: the agent failed or is still going. The last
  line of `.sidequest/agent.log` says which, with its exit code. A session
  only runs once; to run it again, `touch .sidequest/pending` in the worktree
  and `sidequest reopen <branch>`.

## Security

The overlay only talks to the local daemon. The one exception is the thread
reply, which is off unless you turn on `autoReply`: the overlay then posts it
to your workspace's own Slack API with the session Slack's window is already
signed in with. That token stays in the window and never reaches the daemon.
Sidequest runs commands from argv arrays, never through a shell, and passes the
prompt in a file, so message text can't inject commands. That holds for every
terminal: the AppleScript for iTerm2 and Terminal takes the worktree and script
paths as arguments and quotes them itself, and a headless run passes the prompt
to the agent as one argument read from the file. The overlay runs inside
Slack's window, so what the daemon sends it is visible there: channel links,
prompt labels, past sessions' branch names, and (only while a link menu or panel
is open) the paths of the repos it suggests. The sessions panel adds each
session's repo label, channel and git counts, but not its path. Session history is kept in
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
