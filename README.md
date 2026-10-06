# <img src="assets/icon.svg" width="48" height="48" align="top" alt="Sidequest icon"> Sidequest

**Turn any Slack message into a coding-agent session in one click.**

Someone reports a bug in Slack. You hover the message and click **Sidequest → Fix**.
A few seconds later a terminal tab is open on a fresh git worktree, and Claude Code (or
Codex, Gemini CLI, Aider, or [another agent](#agents)) is already working on it,
with the message and its thread as the prompt.
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
- **Nothing leaves your machine** unless you say so. The message and its files
  go from Slack's window into the worktree on disk. The only things posted to
  Slack are the replies you choose to send, as you.
- **It follows the session through.** The message shows how far its session has
  got (working, commits, PR open, merged). When the agent is done, its answer
  waits on the message for you to read, edit and post in the thread.
- **Your checkout is never touched.** Every session gets its own branch and
  worktree, cut from an up-to-date base branch.

## Quick start

You'll need macOS, Node 20+, git, and one of:

- a coding agent on your `PATH`:
  [Claude Code](https://claude.com/claude-code) by default, or Codex, Gemini CLI,
  Aider or any of the [others Sidequest knows](#agents). Sessions open in
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
as a chip inside the message, under its text, like a reaction; click it to
reopen the session, or **×** to dismiss it.

Messages you've already started a session from keep a small **✦ Fix** mark.
Click it to jump back into that session. Its menu also leads with **Back to Fix**,
so you don't cut a duplicate branch by accident.

The mark also says where the session has got to, and keeps up as it moves:

| Mark | Means |
| --- | --- |
| **✦ Fix · working 12m** | Started 12 minutes ago; nothing committed yet |
| **✦ Investigate · answered** | The agent left an answer and committed nothing |
| **✦ Fix · 2 commits** | Commits on the branch that its base doesn't have |
| **✦ Fix · PR #123** | A pull request is open for the branch |
| **✦ Fix · merged** | …and it merged |
| **✦ Fix · PR closed** / **cleaned up** | Closed without merging / the worktree is gone |
| **✦ Fix · failed** | A [headless](#terminals) run exited with an error and left nothing behind (the exit code is in the tooltip) |

Hover the mark for the details (uncommitted changes, the PR's link). Pull
requests are looked up with [`gh`](https://cli.github.com/) when it's installed
and signed in; without it, the mark stops at commits. Sidequest follows the
sessions of the last two weeks, checking every 15 seconds.

**Replies from the agent.** Every prompt ends by asking the agent to write a
short answer for the thread to `.sidequest/result.md` when it's done: what it
found, or what it changed and why. When one appears, a toast says so, and the
mark reads **· reply ready**. Click either (or **Review Fix's reply** at the top
of the message's menu) to read it in Slack's formatting, edit it, and **Post in thread**
(**⌘↵**), as you. **Don't post** drops it. Nothing goes out without that click
unless you set `postResults` to `auto`. If the branch has a pull request, the
reply links it. Every reply ends with a line saying which agent wrote it
(*🤖 Written by Claude Code, an AI agent, via Sidequest*), so the thread knows
it didn't come from you by hand. If the agent rewrites the file later (say you
ask it to change the reply), a new toast says it was updated.

Replies you haven't posted or dropped yet don't get lost when the toast goes or
the message scrolls away: a **💬** count on the channel pill, beside the channel
name, opens the sessions panel with every waiting reply at the top. The panel
(**⌃⇧S**) lists them too.

**Follow-ups.** Agents rarely get it right in one go. On a message whose session
is still around, the menu offers **Follow up on Fix…**: type what to do next
(**Enter** to send) and it goes to the session that is already on it, with any
thread replies since the message, rather than to a new branch. Claude Code,
Codex, Gemini CLI and Aider carry their conversation on (`claude --continue
"…"` and the like); the other agents start afresh in the same worktree, told
where the earlier work is. Headless runs it in the background and answers again,
and the desktop apps open a new session with it in the composer.

**Pull requests.** Sessions commit; they don't push. When you want one reviewed,
**Open a pull request for Fix** in the message's menu (shown once the branch has
commits) pushes the branch and opens a **draft** pull request with `gh`, titled
for its first commit and described by the agent's reply for the thread, then opens
it in your browser. After that the menu offers **View PR #123**. The description
says it came from Slack but not which workspace or channel, since the repo may
be public. `sidequest pr [branch]` does the same from a terminal.

**Reactions.** Turn on `reactions` and the message a session starts from gets
👀, as you, so whoever asked can see it's being handled without a reply in the
thread. It becomes ✅ when you post the agent's reply or the pull request merges,
or ❌ if a headless run fails.

**Notifications.** On a Mac, the daemon also shows a notification when a reply
is ready, a pull request opens or merges, or a headless run fails, since the
toast in Slack only reaches you while you're looking at Slack. `notify: false`
turns them off.

**Screenshots and files.** Files attached to the message (a screenshot of the
bug, a log) come along. The overlay fetches them with Slack's own session, saves
them to `.sidequest/attachments/` in the worktree, and the prompt lists them so
the agent opens them. Up to 6 files, 10 MB each and 20 MB in all.

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
([`client/overlay/`](client/overlay)) over the Chrome DevTools Protocol. The
overlay reads the message, its thread, the sender and the permalink from the page,
and a local daemon then:

1. creates `git worktree add -b <branch> <path> origin/<base>`,
2. writes the prompt to `<worktree>/.sidequest/prompt.md` (git-excluded), and
   the message's files next to it in `.sidequest/attachments/`,
3. opens your terminal on the worktree and starts your agent (or, headless,
   runs it in the background, or opens your agent's desktop app there, see
   [Desktop apps](#desktop-apps)),
4. keeps an eye on the worktree (commits, pull request, `.sidequest/result.md`)
   and tells the overlay, which updates the message's mark and offers the reply.

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

The overlay sits in its own shadow-DOM layer. The one thing it puts into
Slack's DOM is that chip: a single element after a message's content, with its
own shadow root, so it scrolls with the message instead of floating over it.
It picks up your Slack theme and moves out of the way of Slack's own buttons.

## CLI

| Command | What it does |
| --- | --- |
| `sidequest setup` | First run in one command: config, shell hook, checks, start |
| `sidequest start` / `stop` / `status` | Run the background daemon (logs in `~/.sidequest/sidequest.log`, moved to `sidequest.log.1` at start once it passes 5 MB) |
| `sidequest update` | Pull the latest and rebuild, reinstalling dependencies only if they changed; restarts a running daemon (`--no-restart` to skip) |
| `sidequest doctor` | Check git, your terminal, the agent, Slack.app, the debug port, and whether the build is current |
| `sidequest sessions` | List every worktree Sidequest created (in Slack, **⌃⇧S** shows your recent ones) |
| `sidequest reopen [ref]` | Reopen a session's terminal (the latest if you name none). A terminal agent that has already run picks up its last conversation there (`claude --continue`, `codex resume --last`, …). Headless, it opens the answer, or the log while it's still running |
| `sidequest pr [ref]` | Push a session's branch and open a draft pull request for it with `gh` (the latest if you name none) |
| `sidequest stats` | Your total, today's count, current and best streak |
| `sidequest clean` | Remove merged worktrees. It won't delete uncommitted work unless you pass `--force`, or anything touched in the last hour unless you pass `--recent`. Turn on `autoClean` and the daemon does this for you |
| `sidequest link <path> -c <channel>` | Link a repo to a channel from the terminal. Linking a second repo adds it; the first stays the default |
| `sidequest unlink [repo] -c <channel>` | Unlink one repo (by path or label) from a channel, or all of them if you name none |
| `sidequest replies [on\|off]` | Show the thread replies sessions post, or turn them on or off |
| `sidequest sync [on\|off]` | Share channel links, prompts and settings with your other computers through Slack. See [Syncing between computers](#syncing-between-computers) |
| `sidequest agents [id]` | Show the available agents and how each is run, or switch the one new sessions use (`sidequest agents gemini`, `sidequest agents claude-desktop`) |
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
the background, reading the prompt from its file. Everything it prints goes to
`.sidequest/agent.log` in the worktree, and its final answer to
`.sidequest/result.md` (only when it finishes cleanly, and only if the agent
didn't already write its own thread reply there, which then wins). Only agents whose CLI
has a one-shot mode that prints just the answer can run this way:

| Agent | Headless run |
| --- | --- |
| `claude` | `claude -p --permission-mode acceptEdits "<prompt>"` |
| `codex` | `codex exec --full-auto --output-last-message .sidequest/result.md "<prompt>"` |
| `gemini` | `gemini -p "<prompt>"` |
| `cursor-agent` | `cursor-agent -p "<prompt>"` |
| `qwen` | `qwen -p "<prompt>"` |

The others (Aider, opencode, Copilot CLI, Goose) are refused with a clear error
before any worktree is cut, as are the desktop-app agents, which ignore the
terminal setting anyway. Nobody is there to approve anything, so each agent
runs with limits: Claude Code may edit files in the worktree but not run
commands, Codex runs in its workspace-write sandbox, Cursor Agent's print mode
changes nothing without `--force`, and Gemini CLI and Qwen Code leave out tools
that would need approval. Your `agent.args` go after those flags, before the
prompt. `sidequest agents` shows each agent's headless run. Clicking the session later (or
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
`"hidden": true` takes one out of the menu, and `"agent"` runs that prompt with
another [agent](#agents) than the rest, say Review with Codex while Fix stays on
Claude Code (`"review": { "agent": "codex" }`). The menu names the agent beside
such a prompt, and reopening or following up on its sessions uses it too. An agent
picked this way runs with its own defaults: `settings.agent`'s `command` and `args`
are for that agent only.

**Prompts of your own.** Any other key adds a prompt to the menu, after the
built-in ones, in the order your config lists them. It needs a `label` and a
`template`. It can have an `emoji` (a Slack shortcode like `test_tube`), a
`reply` for thread replies, and a `branchPrefix`, which is the key unless you
set one. It gets a number key and, if no other prompt starts with the same
letter, a letter key, just like the built-in ones:

```json
{
  "prompts": {
    "write-test": {
      "label": "Write a test",
      "emoji": "test_tube",
      "template": "Write a failing test that reproduces this, from @{{author}} in #{{channel}}:\n{{message}}\n{{thread}}{{attachments}}\nCommit it on {{branch}}. Don't fix the bug."
    },
    "review": { "hidden": true }
  }
}
```

A key is lowercase letters, digits and dashes. `sidequest prompts` shows every
prompt as it stands.

Tokens: `{{author}}` `{{channel}}` `{{message}}` `{{thread}}` `{{permalink}}`
`{{date}}` `{{branch}}` `{{baseBranch}}` `{{repo}}` `{{worktree}}`, plus
`{{ticket}}` (the link) and `{{ticketId}}` (`DATA-3051`, `owner/repo#123` or
`ABC-123`) for Linear, GitHub and Jira, `{{question}}` (what you typed in
the Ask box, empty otherwise), and `{{attachments}}` (the list of the message's
files saved in the worktree, empty when it had none; a template without it
still gets the list at the end). Every prompt also ends with the request for a
reply in `.sidequest/result.md`, unless `postResults` is `off`. Sidequest
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

<a id="agents"></a>
**Agents.** In a terminal, every session starts an interactive agent whose first turn
is the prompt. Each CLI takes that prompt its own way, and Sidequest knows which.
The two app agents open a [desktop app](#desktop-apps) with the prompt ready instead:

| Id | Agent | Runs |
| --- | --- | --- |
| `claude` | [Claude Code](https://claude.com/claude-code) | `claude "<prompt>"` |
| `codex` | [Codex](https://github.com/openai/codex) | `codex "<prompt>"` |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini --prompt-interactive "<prompt>"` |
| `aider` | [Aider](https://aider.chat) | `aider --message-file .sidequest/prompt.md`, then `aider --restore-chat-history` |
| `cursor-agent` | [Cursor Agent](https://cursor.com/cli) | `cursor-agent "<prompt>"` |
| `opencode` | [opencode](https://opencode.ai) | `opencode --prompt "<prompt>"` |
| `copilot` | [Copilot CLI](https://github.com/github/copilot-cli) | `copilot --interactive "<prompt>"` |
| `qwen` | [Qwen Code](https://github.com/QwenLM/qwen-code) | `qwen --prompt-interactive "<prompt>"` |
| `goose` | [Goose](https://github.com/block/goose) | `goose run --interactive --instructions .sidequest/prompt.md` |
| `claude-desktop` | Claude Code in the [Claude app](https://claude.com/download) | opens `claude://code/new` |
| `chatgpt` | Codex in the [ChatGPT app](https://chatgpt.com/download) | opens `codex://threads/new` |

Aider is the odd one out: it has no way to open a chat with a first message
(its bare arguments are files to edit, and `--message-file` answers once and
exits). So Sidequest sends the prompt that way, and when it's done reopens Aider
on the same chat so you can carry on. Your `args` go right after the command,
before the prompt (in both of Aider's runs). `sidequest doctor` checks the active
agent with `--version` (or, for an app agent, that the app is installed) and says
how to install it if that fails.

**Settings** (under `settings`):

| Setting | Default | |
| --- | --- | --- |
| `agent` | `{ "id": "claude" }` | Any id from [Agents](#agents): a CLI in your terminal, or `claude-desktop` or `chatgpt` in their desktop apps (or run `sidequest agents codex`). Use `command`/`args` to override a terminal agent's executable and add flags |
| `worktreesRoot` | `~/.sidequest/worktrees` | Where worktrees go |
| `terminal` | `warp` | `warp`, `iterm2`, `ghostty`, `terminal`, `tmux` or `headless` (or run `sidequest terminal <name>`). See Terminals above. Ignored by the desktop-app agents |
| `tmuxSession` | `""` | The tmux session new windows go into. Empty means the one you used last |
| `warpStrategy` | `auto` | Warp only. `auto` tries a tab config, then a launch config, then a plain new tab, until the agent starts. `tab_config`, `launch_config` or `new_tab` puts that one first |
| `warpPreview` | `false` | Warp only. Use Warp Preview |
| `fetchBeforeCreate` | `true` | Fetch the base branch first. The fetch starts when the menu opens, and one made in the last minute is reused rather than repeated. A fetch slower than 3 seconds doesn't hold up the session: it's cut from the local ref while the fetch finishes in the background. Off, nothing is fetched at all |
| `repoSearchRoots` | `[]` | Where to look for repos to suggest. Empty means `~/code`, `~/src`, `~/Developer`, `~/projects` and similar, two levels deep |
| `threadContextLimit` | `10` | How many earlier messages go into the prompt |
| `pruneBranchesOnClean` | `true` | Delete merged branches on `clean` (and on auto-clean, and when you remove a session from the sessions panel) |
| `autoClean` | `false` | Let the running daemon remove finished worktrees itself. See Cleaning up below |
| `autoCleanAfterDays` | `7` | How long a merged worktree has to sit untouched before auto-clean removes it |
| `cdpPort` | `9222` | DevTools port for Slack |
| `relaunchSlack` | `true` | While Sidequest runs, relaunch a Slack reopened from the Dock (without the DevTools port) so the overlay comes back |
| `targetUrlPattern` | `app\.slack\.com\|/client/` | Which windows count as Slack |
| `autoReply` | `false` | Reply in the message's thread when a session starts. See Thread replies above |
| `reactions` | `false` | React to the message a session starts from, as you: 👀 while it works, then ✅ (reply posted or PR merged) or ❌ (headless run failed). See Reactions above |
| `notify` | `true` | Show a macOS notification when a session's reply is ready, its PR opens or merges, or a headless run fails |
| `postResults` | `ask` | What to do with the reply the agent leaves in `.sidequest/result.md`: `ask` offers it on the message to review and post, `auto` posts it in the thread as soon as it's written, `off` doesn't ask the agent for one. See Replies from the agent above |
| `trackStatus` | `true` | Follow each session's commits and pull request (with `gh`) and show them on its mark. Pull requests come from one `gh pr list` per repo; a branch with none is asked about every 90 seconds for its first day, then every 10 minutes, and a worktree untouched for a day is looked at in full every 10 minutes. With this and `postResults` both off, the daemon doesn't look in on sessions at all; turning either back on takes a `sidequest stop` and `start` |
| `verbose` | `false` | Log overlay activity to Slack's devtools console |
| `sync` | `false` | Keep channel links, prompts and the portable settings in step with your other computers, through Slack (or run `sidequest sync on`). See Syncing between computers below |

### Syncing between computers

Use the same Slack on more than one Mac? Run `sidequest sync on` on each of
them, and they share their channel links, prompts and settings. Link
`#storefront` to a repo on your laptop, and a minute or two later it's linked
on your desktop too.

There's no server or account to set up. The shared copy is a pinned message in
your DM with yourself in Slack, which the overlay reads and edits as you, the
same way it posts thread replies. The running daemon looks at it every two
minutes, and sends your own changes up a few seconds after you make them.

- **Repos are matched by their git remote**, not their path, so each computer
  links its own checkout wherever it lives (`~/code/storefront` on one,
  `~/src/storefront` on the other). It looks where repo suggestions look:
  `repoSearchRoots`, or `~/code`, `~/src`, `~/Developer` and similar. A repo
  you haven't cloned on a computer yet waits there and links itself once you
  clone it; `sidequest sync` lists the ones that are waiting. A repo with no
  remote is matched by its folder name.
- **What syncs:** channel links (with each one's base branch and label),
  `prompts`, and the settings that mean the same anywhere: `agent` (its `id`
  and `args`, not `command`, which is often a path), `fetchBeforeCreate`,
  `threadContextLimit`, `pruneBranchesOnClean`, `autoClean`,
  `autoCleanAfterDays`, `autoReply`, `reactions`, `postResults` and `trackStatus`.
- **What stays on each computer:** `worktreesRoot`, `terminal` and the other
  terminal settings, `repoSearchRoots`, the Slack settings (`cdpPort`,
  `relaunchSlack`, `targetUrlPattern`), `verbose`, and your session history.
- **When two computers change things before either syncs**, both changes are
  kept as long as they touch different things. If both change the same
  setting or prompt, the version already in Slack wins; if both change the
  same channel's repos, the channel gets the repos from both.

The first time you turn it on on a second computer, its links are added to the
ones already in Slack, and the settings in Slack win over its own. Leave the
message pinned. If your workspace stops you editing messages after a while,
Sidequest posts a fresh one and unpins the old. `sidequest sync off` stops
syncing on that computer and leaves the message where it is.

**Cleaning up.** Every session leaves a worktree behind. `sidequest clean`
removes the ones whose branch is merged into the base, deleting the branch too
(with `git branch -d`, which refuses one holding commits the base doesn't
have), and never a worktree with uncommitted changes unless you pass `--force`.
It also leaves alone anything touched in the last hour: Investigate, Review and
Ask commit nothing, so their branch counts as merged the moment it's cut, while
the agent may still be working in it or you may still be reading what it
found. Pass `--recent` when you know they're done.

Turn on `autoClean` and the running daemon does the same every six hours, by
the same rules, except that it waits until nothing has touched a worktree for
`autoCleanAfterDays` rather than an hour. It never fetches, so "merged" means
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
  attached windows, the overlay wasn't injected. (`status` reads the count from
  the end of the log; when it says nothing about windows, look in the log.)
- **"Another Sidequest daemon (pid …) is already attached to Slack"** in the
  log: only one daemon runs at a time, so a second `start` (or a
  `start --foreground` beside the background one) exits. `sidequest stop`
  stops the running one. A daemon that crashed leaves `~/.sidequest/sidequest.lock`
  behind; the next `start` takes it over on its own.
- **"sidequest did not answer"** on a message: the daemon is not running, or
  is stuck. Starting a session waits up to two minutes; anything else gives up
  after a few seconds. Check `sidequest status` and the log.
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
  tried. The message says "Starting…" only until the terminal opens; if the agent
  then doesn't start, that is added to the message's line a few seconds later.
  Then retry, or run `sidequest reopen` (latest) / `sidequest reopen <branch>`.
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

The overlay only talks to the local daemon, with a few exceptions, and all use
the session Slack's window is already signed in with. That token stays in the
window and never reaches the daemon.

- **Thread replies:** the one a session posts when it starts (off unless you
  turn on `autoReply`) and the agent's answer, which posts only when you click
  **Post in thread** (or on its own if you set `postResults` to `auto`). Both
  go to your workspace's own Slack API.
- **Reactions** (off unless you turn on `reactions`): 👀, ✅ and ❌ on the
  message a session started from, through the same API as the replies.
- **Attachments:** the overlay downloads the message's files from Slack's file
  host and hands the bytes to the daemon, which writes them into the worktree.
- **Settings sync** (off unless you run `sidequest sync on`): the overlay
  reads and edits one pinned message in your DM with yourself, holding your
  channel links (by git remote, not path), prompts and portable settings.
  Only you can see that DM, but anyone with access to your Slack account
  could read it, and so could your workspace's admins if they can export
  DMs. It holds no tokens or repo paths, though it names the computer that
  last changed it.

An agent's answer is written by the agent, which read the message, so read it
before you post it; that's why `ask` is the default. Nothing is pushed to your
git remote unless you click **Open a pull request** (or run `sidequest pr`).
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
