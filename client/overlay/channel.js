function buildChannelButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sq-pill sq-channel sq-off';

  const dot = document.createElement('span');
  dot.className = 'sq-dot';
  const icon = document.createElement('span');
  icon.className = 'sq-icon';
  icon.innerHTML = iconSvg();
  const label = document.createElement('span');
  label.className = 'sq-label sq-channel-label';
  const count = document.createElement('span');
  count.className = 'sq-reply-count';
  hide(count);
  button.append(dot, icon, label, count);

  button.addEventListener('click', (event) => {
    stop(event);
    if (count.contains(event.target)) {
      toggleSessions();
      schedule();
      return;
    }
    if (panelEl) closePanel();
    else openPanel(null);
    schedule();
  });
  return button;
}

/*
 * Linking a channel to a repo needs a path, and the overlay has nowhere good
 * to browse the filesystem from. Electron does not implement window.prompt,
 * so the panel is the overlay's own — one input in the shadow layer, with
 * the daemon still deciding whether the path is a real repo.
 */
function closePanel() {
  panelEl?.remove();
  panelEl = null;
  boxKeys = null;
}

/**
 * A panel's text box or the menu's Ask box, while it holds the keyboard.
 * Focus inside a shadow root reads as the host from the outside, so this is
 * the only way to tell an event meant for the box from one meant for Slack.
 */
function typingBox() {
  if (!ui) return null;
  const active = ui.activeElement;
  if (!active || !/^(INPUT|TEXTAREA)$/.test(active.tagName)) return null;
  return (panelEl && panelEl.contains(active)) || (menuEl && menuEl.contains(active)) ? active : null;
}

/** A path is one line, whatever shape the clipboard carried it in; a question keeps its lines. */
function insertText(input, text) {
  const flat = input.tagName === 'TEXTAREA' ? text : text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!flat) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(flat, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Opened from the channel pill, or from the message menu — in which case
 * `returnRow` is the message it came from, and linking goes straight back
 * to that message's prompts.
 */
function openPanel(returnRow = null) {
  closeMenu();
  closePanel();
  closeSessions();

  // From a message's menu, the message's channel: in Threads it is not the
  // page's.
  const channel = returnRow ? channelFor(returnRow) : currentChannel();
  if (!channel) return;
  const current = reposFor(channel);

  const panel = document.createElement('div');
  panel.className = 'sq-panel';

  const title = document.createElement('div');
  title.className = 'sq-panel-title';
  title.textContent = current.length > 1 ? `Repos for #${channel}` : `Repo for #${channel}`;

  // What the channel is on now, each with a way off it. The first is where
  // sessions start unless the menu picks another.
  const linked = document.createElement('div');
  linked.className = 'sq-linked';
  for (const [i, repo] of current.entries()) {
    const item = document.createElement('div');
    item.className = 'sq-linked-row';
    const name = document.createElement('span');
    name.className = 'sq-linked-name';
    name.textContent = repo;
    item.append(name);
    if (current.length > 1 && i === 0) {
      const tag = document.createElement('span');
      tag.className = 'sq-sub';
      tag.textContent = 'default';
      item.append(tag);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'sq-linked-x';
    x.textContent = '×';
    x.title = `Unlink ${repo} from #${channel}`;
    x.setAttribute('aria-label', x.title);
    x.addEventListener('click', (event) => {
      stop(event);
      panel.dataset.busy = '1';
      hide(error);
      unlinkRepo(channel, repo, (text) => {
        error.textContent = text;
        show(error);
        delete panel.dataset.busy;
      }).then((ok) => {
        if (!ok || panelEl !== panel) return;
        // Reopened rather than patched, so the list, the wording and the
        // suggestions all agree with what the channel has now.
        openPanel(returnRow);
        schedule();
      });
    });
    item.append(x);
    linked.append(item);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'sq-suggest-list';

  const note = document.createElement('div');
  note.className = 'sq-panel-note';
  note.textContent = current.length > 0
    ? `Add another and #${channel}'s menu asks which repo to work in.`
    : 'Pick a checkout, or paste the path to one.';

  const error = document.createElement('div');
  error.className = 'sq-panel-error sq-off';

  const actions = document.createElement('div');
  actions.className = 'sq-panel-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.dataset.primary = '1';
  submit.textContent = current.length > 0 ? 'Add' : 'Link';
  actions.append(cancel, submit);

  // The channel button is where the overlay's own business lives, so the
  // sessions panel is reached from here as well as from its shortcut.
  const head = document.createElement('div');
  head.className = 'sq-panel-head';
  const toSessions = document.createElement('button');
  toSessions.type = 'button';
  toSessions.className = 'sq-panel-aside sq-to-sessions';
  toSessions.textContent = 'Sessions ›';
  toSessions.title = `Your recent sessions, to reopen or clean up — ${SESSIONS_KEY_LABEL}`;
  toSessions.addEventListener('click', (event) => {
    stop(event);
    openSessions();
  });
  head.append(title, toSessions);

  input.placeholder = current.length > 0
    ? 'Add a repo: search, or paste a path'
    : 'Search your repos, or paste a path';
  if (current.length === 0) hide(linked);
  panel.append(head, linked, input, list, note, error, actions);

  let repos = [];
  let visible = [];
  let active = -1;
  const pathLike = (value) => /^[~/]/.test(value.trim());

  const render = () => {
    const query = input.value.trim().toLowerCase();
    visible = pathLike(query)
      ? repos.filter((r) => r.path.toLowerCase().startsWith(query) || (r.display || '').toLowerCase().startsWith(query))
      : repos.filter((r) => !query || r.name.toLowerCase().includes(query) || (r.display || r.path).toLowerCase().includes(query));
    visible = visible.slice(0, PANEL_SUGGESTIONS);
    // A path being typed or pasted is the answer; the list only helps finish it.
    active = visible.length > 0 && !pathLike(query) ? Math.min(Math.max(active, 0), visible.length - 1) : -1;
    list.replaceChildren(...visible.map((repo, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sq-suggest';
      if (i === active) item.dataset.active = '1';
      if (repo.score > 0) item.dataset.match = '1';
      item.title = repo.path;
      const name = document.createElement('span');
      name.className = 'sq-suggest-name';
      name.textContent = repo.name;
      const where = document.createElement('span');
      where.className = 'sq-suggest-path';
      where.textContent = repo.display || repo.path;
      item.append(name, where);
      item.addEventListener('click', (event) => {
        stop(event);
        send(repo.path);
      });
      return item;
    }));
    if (visible.length > 0) show(list);
    else hide(list);
    schedule();
  };
  hide(list);

  function send(forced) {
    const value = input.value.trim();
    const picked = active >= 0 && !pathLike(value) ? visible[active] : null;
    const repoPath = forced !== undefined ? forced : picked ? picked.path : value;
    // An empty box is not a request to unlink; the × beside a repo is.
    if (!repoPath) {
      error.textContent = 'Pick a repo, or paste the path to one.';
      show(error);
      input.focus();
      schedule();
      return;
    }
    panel.dataset.busy = '1';
    hide(error);
    linkRepo(channel, repoPath, returnRow, (text) => {
      error.textContent = text;
      show(error);
      delete panel.dataset.busy;
      input.focus();
    }).then((ok) => {
      if (ok && panelEl === panel) closePanel();
    });
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  cancel.addEventListener('click', (event) => {
    stop(event);
    closePanel();
    schedule();
  });
  submit.addEventListener('click', (event) => {
    stop(event);
    send();
  });
  // Reached from the window-level claim in triggers.js rather than
  // from a listener here: that claim has to stop the event before Slack's
  // own document listeners see it, which is early enough that it never
  // reaches this input at all.
  boxKeys = (event) => {
    if (event.key === 'Enter') send();
    if (event.key === 'Escape') { closePanel(); schedule(); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visible.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = active < 0 ? 0 : (active + step + visible.length) % visible.length;
      render();
    }
  };

  panelEl = panel;
  ui.append(panel);
  input.focus();
  suggestRepos(channel).then((found) => {
    if (panelEl !== panel) return;
    repos = found;
    render();
  });
  schedule();
}

/*
 * Slack's own header controls start immediately to the right of the channel
 * name — the dropdown chevron, the huddle button, the bell — and in a narrow
 * window there is barely a gap between them. A pill dropped at the name's
 * right edge lands on top of them and, because it takes its own clicks,
 * swallows theirs. So the free space is measured first: the label truncates if
 * it will not fit, then goes entirely, and then so does the pill. Linking is
 * reachable from the message menu and the CLI either way.
 */

/**
 * Where the channel-name control ends. Slack wraps the name in a button that
 * also holds the chevron, so the text's own box stops short of the control's.
 */
function channelAnchorBox(anchor) {
  const rect = anchor.getBoundingClientRect();
  const box = { right: rect.right, top: rect.top, height: rect.height };
  const control = anchor.closest('button, [role="button"]');
  if (!control || control === anchor) return box;
  const outer = control.getBoundingClientRect();
  // A control wider than the name plus a chevron is something else — a whole
  // header pretending to be a button — and is not what the pill follows.
  if (outer.right > rect.right && outer.right - rect.right <= 80) box.right = outer.right;
  return box;
}

/** How much clear room there is to the right of the name, in pixels. */
function headerRoom(anchor, box) {
  const header = anchor.closest(SEL.header);
  if (!header) return window.innerWidth - box.right;
  let edge = header.getBoundingClientRect().right;
  header.querySelectorAll(HEADER_CONTROLS).forEach((el) => {
    if (el === anchor || el.contains(anchor) || anchor.contains(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    // Only what lies to the right of the name can be collided with.
    if (rect.left < box.right) return;
    if (rect.left < edge) edge = rect.left;
  });
  return edge - box.right;
}

function refreshChannelButton() {
  const anchor = document.querySelector(SEL.channel);
  const channel = anchor ? anchor.textContent.trim().replace(/^#+/, '') : '';

  // Nothing identifiable on screen — a preferences pane, or Slack still
  // starting. A button that cannot say which channel it means should not be
  // offering to link one.
  if (!channel) {
    hide(channelBtn);
    closePanel();
    return;
  }
  if (channelBtn.dataset.channel && channelBtn.dataset.channel !== channel) closePanel();
  channelBtn.dataset.channel = channel;

  const linked = isLinked(channel);
  const repos = reposFor(channel);
  const repo = repos.length > 1 ? `${repos[0]} +${repos.length - 1}` : repos[0] || '';
  const flag = linked ? '1' : '0';
  if (channelBtn.dataset.linked !== flag) channelBtn.dataset.linked = flag;

  const label = channelBtn.querySelector('.sq-channel-label');
  const text = linked ? repo || 'Linked' : 'Link a repo';
  if (label.textContent !== text) label.textContent = text;

  let title = linked
    ? repos.length > 1
      ? `#${channel} starts ${CONFIG.agentLabel} sessions in ${repos.join(', ')} — click to add or unlink`
      : `#${channel} starts ${CONFIG.agentLabel} sessions in ${repo} — click to add another or unlink`
    : `Link #${channel} to a git repo so messages can start ${CONFIG.agentLabel} sessions`;
  title += `\n${SESSIONS_KEY_LABEL} lists your sessions`;
  const waiting = CONFIG.postResults === 'ask' ? pendingReplies().length : 0;
  const count = channelBtn.querySelector('.sq-reply-count');
  const countText = waiting ? `💬 ${waiting}` : '';
  if (count.textContent !== countText) {
    count.textContent = countText;
    count.title = `${waiting} ${waiting === 1 ? 'reply' : 'replies'} from your sessions waiting to be posted — click to see them`;
    if (waiting) show(count);
    else hide(count);
  }
  if (waiting) title += `\n${waiting} ${waiting === 1 ? 'reply is' : 'replies are'} waiting: click 💬 to review`;
  if (channelBtn.title !== title) channelBtn.title = title;

  const box = channelAnchorBox(anchor);
  if (box.right === 0 && box.height === 0) {
    hide(channelBtn);
    return;
  }

  // Measured while visible: a hidden element has no width to compare.
  show(channelBtn);
  delete channelBtn.dataset.compact;
  channelBtn.style.maxWidth = '';
  const room = Math.floor(headerRoom(anchor, box)) - GAP * 2;
  if (channelBtn.offsetWidth > room) {
    if (room >= 64) channelBtn.style.maxWidth = `${room}px`;
    else channelBtn.dataset.compact = '1';
  }
  if (channelBtn.offsetWidth > room) {
    hide(channelBtn);
    placePanel();
    return;
  }
  placeAt(channelBtn, box.right + GAP, box.top + (box.height - channelBtn.offsetHeight) / 2);
  placePanel();
}

/** Under the pill when there is one on screen, and under the header when not. */
function placePanel() {
  if (!panelEl) return;
  // A reply belongs to no channel pill: it can arrive from anywhere.
  const pill = panelEl.dataset.reply ? { width: 0 } : channelBtn.getBoundingClientRect();
  if (pill.width > 0) {
    placeAt(panelEl, pill.left, pill.bottom + 6);
    return;
  }
  // The panel was opened from the message menu, with no pill to hang off.
  const header = document.querySelector(SEL.header);
  const top = header ? header.getBoundingClientRect().bottom + 8 : 12;
  placeAt(panelEl, (window.innerWidth - panelEl.offsetWidth) / 2, top);
}
