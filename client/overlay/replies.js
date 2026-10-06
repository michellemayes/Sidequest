/**
 * Replies announced, by branch and the write of result.md they came from,
 * so each is announced once and a rewritten one is announced again.
 */
const announced = new Set();

function replyKey(entry) {
  return `${entry.branch}\u0000${(entry.status && entry.status.replyAt) || ''}`;
}

/** Every reply waiting to be posted or dropped, newest first. */
function pendingReplies() {
  const out = [];
  for (const list of Object.values(CONFIG.sessions || {})) {
    for (const entry of list) if (entry.status && entry.status.reply) out.push(entry);
  }
  return out.sort((a, b) => ((b.status.replyAt || 0) - (a.status.replyAt || 0)) || String(b.at).localeCompare(String(a.at)));
}

/**
 * Say so when an agent leaves a reply, wherever in Slack you are, with a
 * way straight to it. On auto the daemon posts it instead, so there is
 * nothing to ask. Replies waiting from before the window opened are on
 * their messages; they are not news.
 */
function announceReplies() {
  const pending = pendingReplies();
  for (const entry of pending) {
    const key = replyKey(entry);
    if (announced.has(key)) continue;
    const rewritten = Array.from(announced).some((k) => k.startsWith(`${entry.branch}\u0000`));
    announced.add(key);
    if (CONFIG.postResults !== 'ask') continue;
    toast({
      title: rewritten
        ? `${entry.label || 'A session'} updated its reply for the thread`
        : `${entry.label || 'A session'} has a reply for the thread`,
      sub: `${entry.branch} · also under 💬 in the header`,
      action: { label: 'Review', run: () => openReplyPanel(entry.branch) },
    });
  }
  // Keep only the latest write per branch, so the next one reads as a rewrite.
  const live = new Set(pending.map(replyKey));
  for (const key of Array.from(announced)) {
    const branch = key.split('\u0000')[0];
    if (!live.has(key) && pending.some((e) => e.branch === branch)) announced.delete(key);
  }
}
for (const entry of pendingReplies()) announced.add(replyKey(entry));

/**
 * The agent's reply, to read and edit before it goes out as you. Nothing
 * posts without a click here (unless postResults is auto).
 */
function openReplyPanel(branch) {
  closeMenu();
  closePanel();
  closeSessions();
  if (!ensureLayer()) return;

  const panel = document.createElement('div');
  panel.className = 'sq-panel sq-reply';
  panel.dataset.reply = '1';
  panel.dataset.busy = '1';
  const title = document.createElement('div');
  title.className = 'sq-panel-title';
  title.textContent = 'Reply in the thread';
  const note = document.createElement('div');
  note.className = 'sq-note';
  note.textContent = `Loading ${branch}…`;
  panel.append(title, note);
  panelEl = panel;
  ui.append(panel);
  schedule();

  ask({ op: 'get-result', branch }).then((res) => {
    if (panelEl !== panel) return;
    delete panel.dataset.busy;
    if (res.error) {
      note.textContent = res.error;
      return;
    }
    title.textContent = `${res.label || 'Session'}'s reply${res.channel ? ` in #${res.channel}` : ''}`;
    note.textContent = `Posted in the thread as you, marked as written by ${res.agent || CONFIG.agentLabel}. Edit it first if you like.`;

    const box = document.createElement('textarea');
    box.className = 'sq-ask-input sq-reply-input';
    box.rows = 10;
    box.spellcheck = true;
    box.value = res.text;

    const foot = document.createElement('div');
    foot.className = 'sq-ask-foot';
    const hint = document.createElement('span');
    hint.className = 'sq-ask-hint';
    hint.textContent = '⌘↵ post · Esc close';
    const dismiss = menuButton('sq-reply-skip', () => {
      ask({ op: 'result-posted', branch, resultMs: res.resultMs, dismissed: true }).catch(() => {});
      closePanel();
      schedule();
    });
    dismiss.textContent = 'Don\u2019t post';
    dismiss.title = 'Drop this reply. A new one from the agent is offered again.';
    const post = menuButton('sq-ask-send', () => send());
    post.textContent = 'Post in thread';
    foot.append(hint, dismiss, post);
    panel.replaceChildren(title, note, box, foot);

    function send() {
      const text = box.value.trim();
      if (!text) return;
      panel.dataset.busy = '1';
      postReply(res.permalink, text).then(() => {
        if (panelEl === panel) closePanel();
        toast({ title: 'Replied in the thread', sub: `${res.label || 'Session'} · ${branch}` });
        markPosted({ branch, resultMs: res.resultMs });
        if (CONFIG.reactions) reactDone(res.permalink).catch((err) => log('could not react', err.message));
      }, (err) => {
        if (panelEl !== panel) return;
        delete panel.dataset.busy;
        note.textContent = err.message;
        note.dataset.kind = 'error';
      }).finally(() => schedule());
    }

    boxKeys = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        schedule();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        send();
      }
    };
    box.focus();
    schedule();
  }).catch((err) => {
    if (panelEl !== panel) return;
    delete panel.dataset.busy;
    note.textContent = err.message;
  });
}
