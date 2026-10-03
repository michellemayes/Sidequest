/*
 * What `sidequest sessions` knows, and a little more, without leaving Slack:
 * your recent sessions that still have a worktree, newest first, each with
 * where it came from and what state it is in. The daemon asks git for that
 * state every time the panel opens, which takes a moment, so the last list
 * it sent is drawn straight away in the meantime: opening the panel never
 * waits on git to show something.
 *
 * Removing one follows `sidequest clean`'s rules, and the daemon is what
 * enforces them, not this: uncommitted work is refused unless the request
 * says to discard it, and the panel only says so once the reader has been
 * shown how much would go and has clicked the button that says so.
 */
let sessionsList = null;
let sessionsError = '';
let sessionsLoading = false;
let sessionsTicket = 0;
let sessionsIndex = -1;
/** The row asking whether to remove it: `{ id, dirty }`, dirty > 0 meaning discard. */
let confirming = null;
const removing = new Set();

function closeSessions() {
  sessionsEl?.remove();
  sessionsEl = null;
  sessionsIndex = -1;
  confirming = null;
}

function toggleSessions() {
  if (sessionsEl) {
    closeSessions();
    schedule();
  } else {
    openSessions();
  }
}

function openSessions() {
  if (!ensureLayer()) return;
  closeMenu();
  closePanel();
  closeSessions();

  const panel = document.createElement('div');
  panel.className = 'sq-panel sq-sessions';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Sidequest sessions');
  sessionsEl = panel;
  ui.append(panel);
  loadSessions();
}

function loadSessions() {
  const ticket = ++sessionsTicket;
  sessionsLoading = true;
  renderSessions();
  ask({ op: 'list-sessions' }).then((res) => {
    if (ticket !== sessionsTicket) return;
    if (res.error) {
      sessionsError = res.hint ? `${res.error} ${res.hint}` : res.error;
      return;
    }
    sessionsError = '';
    sessionsList = Array.isArray(res.sessions) ? res.sessions : [];
  }).catch((err) => {
    if (ticket === sessionsTicket) sessionsError = err.message;
  }).finally(() => {
    if (ticket !== sessionsTicket) return;
    sessionsLoading = false;
    renderSessions();
  });
}

/** Redrawn whole on every change: it is a dozen rows, and it keeps them honest. */
function renderSessions() {
  const panel = sessionsEl;
  if (!panel) return;
  const previous = panel.querySelector('.sq-sessions-list');
  const scrollTop = previous ? previous.scrollTop : 0;
  const sessions = sessionsList || [];
  sessionsIndex = Math.min(sessionsIndex, sessions.length - 1);
  if (confirming && !sessions.some((s) => s.id === confirming.id)) confirming = null;

  const head = document.createElement('div');
  head.className = 'sq-panel-head';
  const title = document.createElement('div');
  title.className = 'sq-panel-title';
  title.textContent = 'Sidequest sessions';
  head.append(title);
  if (currentChannel()) {
    const repos = document.createElement('button');
    repos.type = 'button';
    repos.className = 'sq-panel-aside sq-to-repos';
    repos.textContent = 'Repos ›';
    repos.title = `The repos #${currentChannel()} starts sessions in`;
    repos.addEventListener('click', (event) => {
      stop(event);
      openPanel(null);
      schedule();
    });
    head.append(repos);
  }

  const list = document.createElement('div');
  list.className = 'sq-sessions-list';
  list.setAttribute('role', 'listbox');
  sessions.forEach((s, i) => list.append(sessionRow(s, i)));
  if (sessions.length === 0) hide(list);

  const note = document.createElement('div');
  note.className = 'sq-panel-note';
  if (sessions.length === 0) {
    note.textContent = sessionsLoading || !sessionsList
      ? 'Checking your worktrees…'
      : 'No sessions with a worktree left. Hover a message and click Sidequest to start one.';
  } else {
    note.textContent = `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}` +
      (sessionsLoading ? ' · checking…' : ' · ↑↓ ↵ open · ⌫ remove · Esc close');
  }

  const error = document.createElement('div');
  error.className = 'sq-panel-error';
  error.textContent = sessionsError;
  if (!sessionsError) hide(error);

  const replies = repliesSection();
  panel.replaceChildren(...[head, replies, list, note, error].filter(Boolean));
  list.scrollTop = scrollTop;
  keepActiveInView(list);
  schedule();
}

/**
 * Every reply still waiting, whichever message or channel it belongs to,
 * so one whose toast is gone and whose message has scrolled away can still
 * be read, edited and posted. Drawn from the config the daemon pushes, so
 * it covers sessions the list below has no room for.
 */
function repliesSection() {
  if (CONFIG.postResults !== 'ask') return null;
  const pending = pendingReplies();
  if (pending.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'sq-replies';
  const head = document.createElement('div');
  head.className = 'sq-replies-head';
  head.textContent = `💬 ${pending.length === 1 ? 'Reply' : 'Replies'} waiting to post`;
  box.append(head);
  for (const entry of pending) {
    const row = menuButton('sq-reply-row', () => openReplyPanel(entry.branch));
    row.title = `Read ${entry.label || 'the session'}'s reply, edit it, and post it in the thread`;
    spans(row, [
      ['sq-session-branch', entry.branch],
      ['sq-sub', entry.label || ''],
      ['sq-sub', entry.status.replyAt ? ageOf(new Date(entry.status.replyAt).toISOString()) : ''],
    ].filter(([, text]) => text));
    box.append(row);
  }
  return box;
}

/** Scrolled by hand: scrollIntoView could move a scroller of Slack's as well. */
function keepActiveInView(list) {
  const row = list.querySelector('.sq-session[data-active="1"]');
  if (!row) return;
  const top = row.offsetTop - list.offsetTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = top + row.offsetHeight - list.clientHeight;
  }
}

/** "5m", "3h", "2d": how long ago, as tersely as Slack says it. */
function ageOf(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 86400 * 14) return `${Math.floor(secs / 86400)}d`;
  return `${Math.floor(secs / (86400 * 7))}w`;
}

/**
 * What is cheaply known about a session, as [text, tone, tooltip, action?].
 * A chip with an action does that instead of reopening the session.
 */
function sessionChips(s) {
  if (s.state === 'gone') {
    return [['worktree deleted', 'bad', 'The directory is gone; git still has it registered.']];
  }
  const chips = [];
  if (s.pending) chips.push(['not started', '', `${CONFIG.agentLabel} has not picked this session up yet.`]);
  if (typeof s.ahead === 'number') {
    chips.push(s.ahead === 0
      ? ['no commits', '', 'Nothing on the branch that its base does not have.']
      : [`${s.ahead} ${s.ahead === 1 ? 'commit' : 'commits'}`, 'ok', 'Commits on the branch that its base does not have yet.']);
  }
  if (typeof s.dirty === 'number' && s.dirty > 0) {
    chips.push([`${s.dirty} uncommitted`, 'warn', 'Changed or new files not yet committed.']);
  }
  if (pendingReplies().some((e) => e.branch === s.branch)) {
    chips.push(['reply ready', 'reply', 'Read the reply the agent left for the thread, edit it, and post it',
      () => openReplyPanel(s.branch)]);
  }
  return chips;
}

function sessionRow(s, index) {
  const row = document.createElement('div');
  row.className = 'sq-session';
  row.dataset.id = s.id;
  row.dataset.state = s.state;
  row.setAttribute('role', 'option');
  if (index === sessionsIndex) row.dataset.active = '1';
  row.setAttribute('aria-selected', index === sessionsIndex ? 'true' : 'false');
  if (removing.has(s.id)) row.dataset.busy = '1';

  if (confirming && confirming.id === s.id) {
    row.dataset.confirm = confirming.dirty > 0 ? 'force' : 'plain';
    row.append(confirmBox(s, confirming.dirty));
    return row;
  }

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'sq-session-open';
  open.title = s.state === 'gone'
    ? `${s.branch}'s worktree was deleted — × drops what git still keeps of it`
    : reopenHint(s.branch).replace(/^./, (c) => c.toUpperCase());

  const top = document.createElement('span');
  top.className = 'sq-session-top';
  spans(top, [['sq-session-branch', s.branch], ['sq-sub', ageOf(s.createdAt)]]);
  const when = new Date(s.createdAt);
  if (!Number.isNaN(when.getTime())) top.lastChild.title = when.toLocaleString();

  const meta = document.createElement('span');
  meta.className = 'sq-session-meta';
  meta.textContent = [s.promptLabel, s.repo, s.channel ? `#${s.channel}` : ''].filter(Boolean).join(' · ');

  const state = document.createElement('span');
  state.className = 'sq-session-state';
  for (const [text, tone, tip, run] of sessionChips(s)) {
    const chip = document.createElement('span');
    chip.className = 'sq-chip';
    if (tone) chip.dataset.tone = tone;
    chip.textContent = text;
    chip.title = tip;
    if (run) {
      // Inside the row's button, so a span: a button may not hold a button.
      chip.dataset.action = '1';
      chip.addEventListener('click', (event) => {
        stop(event);
        run();
      });
    }
    state.append(chip);
  }

  open.append(top, meta, state);
  open.addEventListener('click', (event) => {
    stop(event);
    sessionsIndex = index;
    if (s.state === 'gone') askRemove(s, index);
    else reopenFromPanel(s);
  });

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'sq-session-x';
  x.textContent = '×';
  x.title = `Remove ${s.branch}'s worktree…`;
  x.setAttribute('aria-label', x.title);
  x.addEventListener('click', (event) => {
    stop(event);
    askRemove(s, index);
  });

  row.append(open, x);
  return row;
}

/**
 * The question, asked in the row. A worktree with uncommitted work says how
 * much and asks to discard it; only that answer sends `force`.
 */
function confirmBox(s, dirty) {
  const box = document.createElement('div');
  box.className = 'sq-session-confirm';
  const text = document.createElement('div');
  if (s.state === 'gone') {
    text.textContent = `Drop ${s.branch}? Its worktree is already deleted; this clears what git still keeps of it.`;
  } else if (dirty > 0) {
    text.textContent = `${s.branch} has ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}. ` +
      `Discard ${dirty === 1 ? 'it' : 'them'} and remove the worktree? This cannot be undone.`;
  } else {
    text.textContent = `Remove ${s.branch}'s worktree? The branch is kept if it has commits that are not merged.`;
  }

  const actions = document.createElement('div');
  actions.className = 'sq-panel-actions';
  const cancel = menuButton('sq-confirm-cancel', () => {
    confirming = null;
    renderSessions();
  });
  cancel.textContent = 'Cancel';
  const go = menuButton('sq-confirm-remove', () => removeFromPanel(s, dirty > 0));
  go.dataset.danger = '1';
  go.textContent = dirty > 0 ? 'Discard and remove' : s.state === 'gone' ? 'Drop' : 'Remove';
  go.title = dirty > 0 ? 'Deletes the uncommitted changes for good' : 'Enter';
  actions.append(cancel, go);

  box.append(text, actions);
  return box;
}

function askRemove(s, index) {
  sessionsIndex = index;
  confirming = { id: s.id, dirty: typeof s.dirty === 'number' && s.dirty > 0 ? s.dirty : 0 };
  renderSessions();
}

function removeFromPanel(s, force) {
  if (removing.has(s.id)) return;
  removing.add(s.id);
  confirming = null;
  sessionsError = '';
  renderSessions();
  ask({ op: 'remove-session', session: s.id, force }).then((res) => {
    if (res.error) {
      if (!force && typeof res.dirty === 'number' && res.dirty > 0) {
        // It changed since the list was drawn. Ask again, now saying what
        // would be lost, rather than failing at the reader.
        confirming = { id: s.id, dirty: res.dirty };
        sessionsList = (sessionsList || []).map((x) => (x.id === s.id ? Object.assign({}, x, { dirty: res.dirty }) : x));
      } else {
        sessionsError = res.hint ? `${res.error} ${res.hint}` : res.error;
      }
      return;
    }
    sessionsList = (sessionsList || []).filter((x) => x.id !== s.id);
    toast({
      title: `Removed ${res.branch || s.branch}`,
      sub: res.removedBranch ? 'Its worktree and branch are gone.' : 'Removed its worktree; kept the branch.',
    });
  }).catch((err) => {
    sessionsError = err.message;
  }).finally(() => {
    removing.delete(s.id);
    renderSessions();
  });
}

/** Into the session's terminal or app: the panel has done its job, so it gets out of the way. */
function reopenFromPanel(s) {
  closeSessions();
  schedule();
  ask({ op: 'reopen', session: s.id, branch: s.branch }).then((res) => {
    if (res.error) {
      toast({ title: 'Could not reopen that session', sub: res.hint ? `${res.error} ${res.hint}` : res.error, kind: 'error' });
      return;
    }
    toast({ title: `Back in ${res.branch || s.branch}`, sub: CONFIG.headless ? 'Opening its result.' : `Opening it in ${CONFIG.agentHost}.` });
  }).catch((err) => {
    toast({ title: 'Could not reopen that session', sub: err.message, kind: 'error' });
  });
}

/**
 * ↑ and ↓ move, Enter opens, Delete or Backspace asks to remove, Escape
 * backs out of the question (and, with none asked, closes the panel through
 * the document-level Escape like every other piece of the overlay). Enter
 * answers a plain removal, never a discard: that takes the button.
 */
function sessionsKeys(event) {
  if (!sessionsEl || event.metaKey || event.ctrlKey || event.altKey) return false;
  const active = document.activeElement;
  if (active && active !== host && active !== document.body
    && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) {
    return false;
  }
  const list = sessionsList || [];
  const key = event.key;
  if (confirming && key === 'Escape') {
    confirming = null;
    renderSessions();
    return true;
  }
  if (confirming && key === 'Enter') {
    const s = list.find((x) => x.id === confirming.id);
    if (s && !(confirming.dirty > 0)) removeFromPanel(s, false);
    return true;
  }
  if ((key === 'ArrowDown' || key === 'ArrowUp') && list.length > 0) {
    const step = key === 'ArrowDown' ? 1 : -1;
    sessionsIndex = sessionsIndex < 0
      ? (step > 0 ? 0 : list.length - 1)
      : (sessionsIndex + step + list.length) % list.length;
    confirming = null;
    renderSessions();
    return true;
  }
  const current = sessionsIndex >= 0 ? list[sessionsIndex] : null;
  if (!current) return false;
  if (key === 'Enter') {
    if (current.state === 'gone') askRemove(current, sessionsIndex);
    else reopenFromPanel(current);
    return true;
  }
  if (key === 'Delete' || key === 'Backspace') {
    askRemove(current, sessionsIndex);
    return true;
  }
  return false;
}

/** Under the channel pill, like the repo panel; under the header when it is hidden. */
function placeSessions() {
  if (!sessionsEl) return;
  const pill = channelBtn.getBoundingClientRect();
  if (pill.width > 0) {
    placeAt(sessionsEl, pill.left, pill.bottom + 6);
    return;
  }
  const header = document.querySelector(SEL.header);
  const top = header ? header.getBoundingClientRect().bottom + 8 : 12;
  placeAt(sessionsEl, (window.innerWidth - sessionsEl.offsetWidth) / 2, top);
}
