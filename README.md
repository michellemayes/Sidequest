# <img src="assets/icon.svg" width="48" height="48" align="top" alt="Sidequest icon"> Sidequest

**Slack message in, fix on a branch out. One click.**

![Sidequest demo: pick Fix on a Slack message, watch Claude Code fix it in a Warp tab on a new worktree, and find the branch linked back in Slack](docs/demo/demo.gif)

Someone posts a bug. You hover it and hit **Sidequest → Fix**. Seconds later
your coding agent is already on it, in its own git worktree, with the message,
the thread and any screenshots as its prompt. When it's done, the branch,
the PR and a ready-to-post reply show up right on the message.

No Slack app. No bot token. No admin approval. It rides on the Slack desktop app
you already have open.

## Try it

macOS, Node 20+, git, and [Claude Code](https://claude.com/claude-code) (or
[another agent](docs/guide.md#agents)):

```bash
git clone https://github.com/michellemayes/Sidequest.git
cd Sidequest
npm install && npm run build && npm link
sidequest setup
```

Then in Slack, hover any message → **Sidequest** → **Fix**.

## What you get

- **Four one-click prompts**: **Investigate**, **Fix**, **Review**, **Ask**
  (or press **1**–**4**). Messages that link a Linear, GitHub or Jira ticket get
  a prompt that fixes that ticket on a branch named for it.
- **Live status on the message**: `✦ Fix · working 12m` → `2 commits` →
  `PR #123` → `merged`. Click it to jump back into the session.
- **Replies you approve**: the agent drafts an answer for the thread; you read,
  edit and post it as you. Nothing goes out without your click.
- **Follow-ups and PRs from Slack**: send the session its next instruction, or
  open a draft PR, from the message's menu.
- **Your agent, your terminal**: Claude Code, Codex, Gemini CLI, Aider, Cursor
  Agent and more, in Warp, iTerm2, Ghostty, Terminal, tmux, headless, or the
  Claude / ChatGPT desktop apps.
- **Nothing leaves your machine** unless you post it. Your main checkout is
  never touched.

## Learn more

The [guide](docs/guide.md) covers everything else: the
[CLI](docs/guide.md#cli), [terminals](docs/guide.md#terminals),
[configuration](docs/guide.md#configuration),
[how it works](docs/guide.md#how-it-works),
[troubleshooting](docs/guide.md#troubleshooting) and
[security](docs/guide.md#security).

Update any time with `sidequest update`.

## License

MIT
