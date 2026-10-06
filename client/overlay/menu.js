function buildLaunchButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sq-pill sq-launch sq-off';

  const dot = document.createElement('span');
  dot.className = 'sq-dot';
  const icon = document.createElement('span');
  icon.className = 'sq-icon';
  icon.innerHTML = iconSvg();
  const label = document.createElement('span');
  label.className = 'sq-label';
  label.textContent = 'Sidequest';
  button.append(dot, icon, label);
  button.title = `Start a ${CONFIG.agentLabel} session from this message`;

  button.addEventListener('click', (event) => {
    stop(event);
    const row = menuRow || hoverRow;
    if (menuEl) {
      closeMenu();
      schedule();
      return;
    }
    if (row && row.isConnected) openMenu(row);
  });
  return button;
}

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  menuRow = null;
  menuSig = '';
  menuIndex = -1;
  boxKeys = null;
}

const stop = (event) => {
  event.preventDefault();
  event.stopPropagation();
};

/** Sessions already started from this message, oldest first. */
function sessionsFor(sig) {
  const list = sig && CONFIG.sessions ? CONFIG.sessions[sig] : null;
  return Array.isArray(list) ? list : [];
}

function menuButton(className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.addEventListener('click', (event) => {
    stop(event);
    onClick();
  });
  return button;
}

function spans(button, parts) {
  for (const [className, text] of parts) {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.textContent = text;
    button.append(span);
  }
  return button;
}

/**
 * A first letter that belongs to one prompt only, so "f" can mean Fix
 * without a custom prompt that also starts with F making it ambiguous.
 */
function promptLetters(prompts) {
  const counts = {};
  for (const prompt of prompts) {
    const letter = String(prompt.label || '').trim().charAt(0).toLowerCase();
    if (letter) counts[letter] = (counts[letter] || 0) + 1;
  }
  return (label) => {
    const letter = String(label || '').trim().charAt(0).toLowerCase();
    return letter && counts[letter] === 1 && /[a-z]/.test(letter) ? letter : '';
  };
}

function openMenu(row) {
  closeMenu();
  closePanel();
  closeSessions();

  const menu = document.createElement('div');
  menu.className = 'sq-menu';
  menu.setAttribute('role', 'menu');
  const channel = channelFor(row);
  const sig = rowSignature(row);

  if (!channel && rowChannelId(row) && viewChannelId() !== null) {
    // A message from a channel the page does not name, as in Threads: find
    // out which before offering anything, so it runs in that channel's repo.
    const note = document.createElement('div');
    note.className = 'sq-note';
    note.textContent = 'Finding this message\u2019s channel…';
    menu.append(note);
    resolveChannel(row).then((name) => {
      if (menuEl !== menu) return;
      if (name) openMenu(row);
      else note.textContent = 'Could not tell which channel this message is in.';
      schedule();
    });
  } else if (!isLinked(channel)) {
    const note = document.createElement('div');
    note.className = 'sq-note';
    note.textContent = channel
      ? `No repo is linked to #${channel} yet.`
      : 'Open a channel to start a session.';
    menu.append(note);

    // Sending the reader off to hunt for another button is a dead end, and
    // in a narrow window that button may have no room to be shown at all.
    // The way out of the menu is in the menu — and usually it is one click:
    // the repos that look like this channel's are offered right here.
    if (channel) {
      const link = menuButton('sq-menu-link', () => {
        const target = menuRow;
        closeMenu();
        openPanel(target);
        schedule();
      });
      link.textContent = 'Link a repo…';
      menu.append(link);
      loadMenuSuggestions(menu, link, channel);
    }
  } else {
    const repos = reposFor(channel);
    if (repos.length > 1) menu.append(repoSwitcher(channel, repos));
    prefetch(channel);

    // A reply an agent left is the first thing worth doing with its message.
    for (const entry of sessionsFor(sig).filter((e) => e.status && e.status.reply).reverse()) {
      const review = menuButton('sq-menu-reply', () => {
        closeMenu();
        openReplyPanel(entry.branch);
        schedule();
      });
      review.title = `Read ${entry.label || 'the session'}'s reply, edit it, and post it in the thread`;
      spans(review, [['sq-glyph', '💬'], ['', `Review ${entry.label || 'session'}'s reply`], ['sq-sub', shortBranch(entry.branch)]]);
      menu.append(review);
    }

    const past = sessionsFor(sig).slice(-2).reverse();
    for (const entry of past) {
      const again = menuButton('sq-menu-reopen', () => {
        closeMenu();
        reopen(entry.branch, sig);
        schedule();
      });
      again.title = reopenHint(entry.branch).replace(/^./, (c) => c.toUpperCase());
      spans(again, [['sq-glyph', '↩'], ['', `Back to ${entry.label || 'session'}`], ['sq-sub', shortBranch(entry.branch)]]);
      menu.append(again);
    }
    const pr = past[0] && prAction(past[0], sig);
    if (pr) menu.append(pr);
    if (past.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'sq-menu-sep';
      menu.append(sep);
    }

    // A tracker's prompt is only worth offering on a message that links
    // one of its tickets, and then once per ticket, named for it.
    const tickets = messageTickets(row);
    const entries = [];
    for (const prompt of CONFIG.prompts) {
      if (!Object.hasOwn(TICKET_PROMPTS, prompt.key)) entries.push({ prompt, ticket: null });
      else for (const ticket of tickets) if (ticket.key === prompt.key) entries.push({ prompt, ticket });
    }
    const letterFor = promptLetters(entries.map((e) => e.prompt));
    entries.forEach(({ prompt, ticket }, index) => {
      const entry = menuButton('sq-menu-prompt', () => {
        if (prompt.key === ASK_KEY && !ticket) {
          openAskBox(prompt);
          return;
        }
        const target = menuRow;
        closeMenu();
        if (target && target.isConnected) startSession(target, prompt, ticket);
        schedule();
      });
      const label = ticket ? `${prompt.label} ${ticket.name}` : prompt.label;
      entry.textContent = label;
      entry.dataset.glyph = glyphFor(prompt.emoji);
      if (index < 9) entry.dataset.key = String(index + 1);
      const letter = letterFor(prompt.label);
      if (letter) entry.dataset.letter = letter;
      entry.title = `${ticket ? `Work ${prompt.label} ${ticket.name}` : prompt.label}${repos.length > 1 ? ' in the picked repo' : ''} with ${prompt.agentLabel || CONFIG.agentLabel} — press ${index + 1}${letter ? ` or ${letter.toUpperCase()}` : ''}`;
      if (prompt.agentLabel) spans(entry, [['sq-agent', prompt.agentLabel]]);
      menu.append(entry);
    });
  }

  menuEl = menu;
  menuRow = row;
  menuSig = sig;
  ui.append(menu);
  schedule();
}

/**
 * The next step for the latest session's work, when there is one: a pull
 * request to open for commits that have none, or the one it has, to view.
 */
function prAction(entry, sig) {
  const status = entry.status || {};
  const label = entry.label || 'session';
  let text;
  let title;
  if (status.pr && status.pr.url) {
    text = `View PR #${status.pr.number}`;
    title = `Open ${status.pr.url} in your browser`;
  } else if (status.state === 'committed') {
    text = `Open a pull request for ${label}`;
    title = `Push ${entry.branch} and open a draft pull request with gh, described by the agent's reply`;
  } else {
    return null;
  }
  const button = menuButton('sq-menu-reopen', () => {
    closeMenu();
    openPr(entry, sig);
    schedule();
  });
  button.title = title;
  spans(button, [['sq-glyph', '⇡'], ['', text], ['sq-sub', shortBranch(entry.branch)]]);
  return button;
}

/** Push and open a session's pull request, or just open the one it has; the line under the message says how it went. */
function openPr(entry, sig) {
  const has = entry.status && entry.status.pr;
  setResult(sig, has ? `Opening PR #${has.number}…` : `Pushing ${entry.branch} and opening a pull request…`, 'busy');
  ask({ op: 'open-pr', branch: entry.branch }).then((res) => {
    if (res.error) {
      setResult(sig, res.hint ? `${res.error} ${res.hint}` : res.error, 'error');
      return;
    }
    setResult(sig, res.created ? `Opened a draft pull request: ${res.url}` : `Opened ${res.url}`, 'info', entry.branch);
  }).catch((err) => setResult(sig, err.message, 'error')).finally(() => schedule());
}

/**
 * A row of the channel's repos at the top of its menu, the picked one lit.
 * Picking one keeps the menu open: it chooses where the prompt below runs,
 * it is not itself something to run. ← and → move along it.
 */
function repoSwitcher(channel, repos) {
  const row = document.createElement('div');
  row.className = 'sq-repos';
  row.setAttribute('role', 'radiogroup');
  const current = pickedRepo(channel);
  for (const repo of repos) {
    const chip = menuButton('sq-repo', () => pickRepo(channel, repo));
    chip.textContent = repo;
    chip.dataset.repo = repo;
    chip.setAttribute('role', 'radio');
    chip.title = `Start sessions from #${channel} in ${repo} — ← → to switch`;
    if (repo === current) chip.dataset.on = '1';
    chip.setAttribute('aria-checked', repo === current ? 'true' : 'false');
    row.append(chip);
  }
  return row;
}

function pickRepo(channel, repo) {
  repoPicks.set(channelKey(channel), repo);
  prefetch(channel);
  if (!menuEl) return;
  menuEl.querySelectorAll('.sq-repo').forEach((chip) => {
    const on = chip.dataset.repo === repo;
    if (on) chip.dataset.on = '1';
    else delete chip.dataset.on;
    chip.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

/**
 * Have the daemon start fetching the repo a session from this channel would
 * be cut from, while the reader is still choosing a prompt. Nothing waits
 * on it: the daemon skips a fetch it has just done and joins one running.
 */
function prefetch(channel) {
  const repo = reposFor(channel).length > 1 ? pickedRepo(channel) : '';
  ask({ op: 'prefetch', channel, repo }).catch(() => {});
}

/**
 * Ask asks for the question first, in the menu itself, so the agent starts
 * on it rather than waiting to be told. The box is optional: sending it
 * empty starts the session with just the message.
 */
function openAskBox(prompt) {
  const menu = menuEl;
  if (!menu) return;
  menu.dataset.asking = '1';
  menuIndex = -1;

  const title = document.createElement('div');
  title.className = 'sq-ask-title';
  title.textContent = `${glyphFor(prompt.emoji)} ${prompt.label}`;

  const box = document.createElement('textarea');
  box.className = 'sq-ask-input';
  box.rows = 3;
  box.spellcheck = true;
  box.placeholder = 'What do you want to know? (optional)';

  const foot = document.createElement('div');
  foot.className = 'sq-ask-foot';
  const hint = document.createElement('span');
  hint.className = 'sq-ask-hint';
  hint.textContent = '⇧↵ new line · Esc cancel';
  const submit = menuButton('sq-ask-send', () => send());
  submit.textContent = prompt.label;
  const channel = channelFor(menuRow);
  const repos = reposFor(channel);
  const where = repos.length > 1 ? ` in ${pickedRepo(channel)}` : '';
  if (where) title.textContent += where;
  submit.title = `Start ${prompt.label}${where} with ${prompt.agentLabel || CONFIG.agentLabel} — Enter`;
  foot.append(hint, submit);

  menu.replaceChildren(title, box, foot);

  function send() {
    const target = menuRow;
    const question = box.value.trim();
    closeMenu();
    if (target && target.isConnected) startSession(target, prompt, null, question);
    schedule();
  }

  // Like the path box, reached from the window-level claim in triggers.js:
  // Slack would otherwise take these keys for its composer.
  boxKeys = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      schedule();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  };

  box.focus();
  schedule();
}

function shortBranch(branch) {
  const text = String(branch || '');
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/** Arrow keys, Enter, and a digit or first letter to pick a prompt. */
function menuKeys(event) {
  if (!menuEl || event.metaKey || event.ctrlKey || event.altKey) return false;
  // In the Ask box a digit is part of the question, not a pick.
  if (menuEl.dataset.asking) return false;
  // Someone typing into Slack's composer with the menu still open is
  // typing, not choosing.
  const active = document.activeElement;
  if (active && active !== host && active !== document.body
    && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) {
    return false;
  }
  const key = event.key;
  const chips = Array.from(menuEl.querySelectorAll('.sq-repo'));
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && chips.length > 1) {
    const step = key === 'ArrowRight' ? 1 : -1;
    const at = Math.max(0, chips.findIndex((c) => c.dataset.on === '1'));
    chips[(at + step + chips.length) % chips.length].click();
    return true;
  }
  // Up and down move through what the menu can do; the repo row is beside that.
  const items = Array.from(menuEl.querySelectorAll('button:not(.sq-repo)'));
  if (items.length === 0) return false;

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    menuIndex = menuIndex < 0
      ? (step > 0 ? 0 : items.length - 1)
      : (menuIndex + step + items.length) % items.length;
    items.forEach((item, i) => {
      if (i === menuIndex) item.dataset.active = '1';
      else delete item.dataset.active;
    });
    return true;
  }
  // Enter only once the reader has moved through the menu: a bare Enter is
  // too likely to be meant for Slack.
  if (key === 'Enter' && menuIndex >= 0 && items[menuIndex]) {
    items[menuIndex].click();
    return true;
  }
  const lower = String(key).toLowerCase();
  const hit = items.find((b) => b.dataset.key === key || (b.dataset.letter && b.dataset.letter === lower));
  if (hit) {
    hit.click();
    return true;
  }
  return false;
}
