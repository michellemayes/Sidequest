/*
 * sidequest overlay — runs inside the Slack desktop app's renderer.
 *
 * Injected over CDP by src/cdp/attacher.ts, which also installs the
 * __sidequestAsk binding this talks to. Nothing here reaches the network; every
 * request goes down to the local daemon and comes back through
 * __sidequestResult.
 *
 * Two pieces of UI:
 *   1. A button on each message, revealed on hover, opening the three prompts.
 *   2. A button in the channel header showing which repo the channel is on.
 *
 * Slack's message list is virtualised: rows are recycled with new content, and
 * the header is rebuilt on every channel switch. So nothing here may assume a
 * node it decorated still holds the message it decorated it for. The overlay is
 * reconciled from the DOM on every mutation instead, and each row records the
 * message it was last decorated for.
 */
(() => {
  if (window.__SIDEQUEST__) return;
  window.__SIDEQUEST__ = true;

  const CONFIG = Object.assign({
    prompts: [],
    linkedChannels: [],
    repoLabels: {},
    verbose: false,
  }, window.__SIDEQUEST_CONFIG || {});

  const ASK = '__sidequestAsk';
  const ATTR_ROW = 'data-sidequest-row';
  const REQUEST_TIMEOUT_MS = 120000;

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    sender: '[data-qa="message_sender_name"]',
    rich: '.p-rich_text_section',
    channel: '[data-qa="channel_name"]',
    header: '[data-qa="channel_header"], .p-view_header__text_container, .p-view_header',
    timestamp: 'a.c-timestamp',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[sidequest]', ...args); };

  /* ---------------------------------------------------------------- styles */

  const STYLE_ID = 'sidequest-style';
  const CSS = `
    /* The row is the hover target. Slack already positions these relatively,
       but say so rather than depending on it. */
    ${SEL.item}[${ATTR_ROW}] { position: relative; }

    /* Parked top-right, where Slack's own hover toolbar sits, but offset below
       it so the two never overlap when both are showing. */
    .sidequest-launch {
      position: absolute; top: 2px; right: 8px; z-index: 20;
      display: none; align-items: center; gap: 5px;
      padding: 2px 8px;
      font-size: 11px; line-height: 16px; font-weight: 500;
      font-family: inherit; color: inherit; opacity: .75;
      background: var(--saf-background, rgba(255,255,255,.96));
      border: 1px solid rgba(127,127,127,.35); border-radius: 7px;
      cursor: pointer; user-select: none;
    }
    ${SEL.item}:hover .sidequest-launch,
    .sidequest-launch[data-open="1"] { display: inline-flex; }
    .sidequest-launch:hover { opacity: 1; border-color: rgba(127,127,127,.6); }
    .sidequest-launch[data-busy="1"] { opacity: .4; pointer-events: none; }

    .sidequest-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #2eb67d; flex: 0 0 auto;
    }
    .sidequest-launch[data-linked="0"] .sidequest-dot { background: #8d8d8d; }

    /* The prompt menu. Anchored to the row, not the button, so it cannot be
       clipped by the button's own stacking context. */
    .sidequest-menu {
      position: absolute; top: 26px; right: 8px; z-index: 30;
      display: flex; flex-direction: column; min-width: 176px;
      padding: 4px;
      background: var(--saf-background, #fff);
      border: 1px solid rgba(127,127,127,.35); border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
    }
    .sidequest-menu button {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; margin: 0;
      font-size: 13px; line-height: 18px; font-family: inherit;
      color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px;
      cursor: pointer;
    }
    .sidequest-menu button:hover { background: rgba(127,127,127,.14); }
    .sidequest-menu .sidequest-menu-note {
      padding: 6px 8px; font-size: 11px; line-height: 15px; opacity: .7;
    }

    /* Result line, left under the message so it reads as an annotation on it
       rather than as a toast that will vanish before it is read. */
    .sidequest-result {
      display: block; margin: 4px 0 6px;
      font-size: 11px; line-height: 16px; opacity: .7;
      word-break: break-word;
    }
    .sidequest-result[data-kind="error"] { color: #e01e5a; opacity: .95; }

    /* The channel header button. Bordered, matching Slack's header affordances. */
    .sidequest-channel {
      display: inline-flex; align-items: center; gap: 5px;
      margin: 0 0 0 8px; padding: 1px 8px; vertical-align: middle;
      font-size: 11px; line-height: 16px; font-weight: 500;
      font-family: inherit; color: inherit; opacity: .62;
      background: transparent;
      border: 1px solid rgba(127,127,127,.35); border-radius: 7px;
      cursor: pointer; user-select: none;
    }
    .sidequest-channel:hover {
      opacity: 1; background: rgba(127,127,127,.13);
      border-color: rgba(127,127,127,.6);
    }
    .sidequest-channel[data-busy="1"] { opacity: .35; pointer-events: none; }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------- transport */

  let seq = 0;
  const pending = new Map();

  window.__sidequestResult = (json) => {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  };

  // Settings changed elsewhere — another window, the menu bar, the terminal.
  window.__sidequestSetConfig = (json) => {
    try {
      Object.assign(CONFIG, JSON.parse(json));
    } catch {
      return;
    }
    refreshChannelButton();
  };

  function ask(payload) {
    if (typeof window[ASK] !== 'function') {
      return Promise.reject(new Error('sidequest binding missing'));
    }
    const id = `r${++seq}`;
    return new Promise((resolve, reject) => {
      // Creating a worktree can mean a fetch over a slow link, so this waits
      // far longer than a UI request normally would.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('sidequest did not answer'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        window[ASK](JSON.stringify(Object.assign({ id }, payload)));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  /* --------------------------------------------------------- reading Slack */

  function currentChannel() {
    const el = document.querySelector(SEL.channel);
    return el ? el.textContent.trim().replace(/^#+/, '') : '';
  }

  function channelKey(name) {
    return String(name || '').trim().replace(/^#+/, '').toLowerCase();
  }

  function isLinked(channel) {
    return CONFIG.linkedChannels.indexOf(channelKey(channel)) !== -1;
  }

  /**
   * Slack renders a sender name only on the first message of a run, so a
   * follow-up message has to look back up the list for the name it belongs to.
   */
  function senderFor(item) {
    let node = item;
    for (let hops = 0; node && hops < 40; hops += 1) {
      const name = node.querySelector?.(SEL.sender);
      if (name) return name.textContent.trim();
      node = node.previousElementSibling;
    }
    return 'unknown';
  }

  function messageText(item) {
    const content = item.querySelector(SEL.content);
    if (!content) return '';
    const sections = content.querySelectorAll(SEL.rich);
    if (sections.length > 0) {
      return Array.from(sections).map((s) => s.innerText.trim()).filter(Boolean).join('\n');
    }
    return content.innerText.trim();
  }

  /**
   * The permalink and the message timestamp both come off Slack's own
   * timestamp anchor: its href is the archives URL, and the id carries the ts.
   */
  function messageMeta(item) {
    const anchor = item.querySelector(SEL.timestamp);
    const permalink = anchor?.href || '';
    let ts = '';
    const fromId = anchor?.id?.match(/(\d{10}\.\d{4,6})/);
    const fromHref = permalink.match(/\/p(\d{10})(\d{6})/);
    if (fromId) ts = fromId[1];
    else if (fromHref) ts = `${fromHref[1]}.${fromHref[2]}`;
    return { permalink, ts };
  }

  /** A stable-enough identity for "is this row still the same message". */
  function rowSignature(item) {
    const { ts } = messageMeta(item);
    if (ts) return ts;
    return messageText(item).slice(0, 120);
  }

  /**
   * Sibling messages in the same thread view, so an "it broke this morning"
   * reply carries the message it is replying to.
   */
  function threadContext(item) {
    const rows = Array.from(document.querySelectorAll(SEL.item));
    const index = rows.indexOf(item);
    if (index === -1) return [];
    return rows
      .slice(Math.max(0, index - 10), index)
      .map((row) => ({ author: senderFor(row), text: messageText(row) }))
      .filter((m) => m.text.length > 0);
  }

  /* ------------------------------------------------------------ row button */

  function closeMenus(except) {
    document.querySelectorAll('.sidequest-menu').forEach((menu) => {
      if (menu !== except) menu.remove();
    });
    document.querySelectorAll('.sidequest-launch[data-open="1"]').forEach((b) => {
      if (!except || b.parentElement !== except.parentElement) delete b.dataset.open;
    });
  }

  function buildLaunchButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidequest-launch';

    const dot = document.createElement('span');
    dot.className = 'sidequest-dot';
    const label = document.createElement('span');
    label.textContent = 'Sidequest';
    button.append(dot, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = button.closest(SEL.item);
      if (!item) return;
      if (button.dataset.open === '1') {
        closeMenus();
        return;
      }
      closeMenus();
      button.dataset.open = '1';
      openMenu(item, button);
    });
    return button;
  }

  function openMenu(item, button) {
    const menu = document.createElement('div');
    menu.className = 'sidequest-menu';
    const channel = currentChannel();

    if (!isLinked(channel)) {
      const note = document.createElement('div');
      note.className = 'sidequest-menu-note';
      note.textContent = channel
        ? `#${channel} has no repo yet — use the button in the channel header.`
        : 'Open a channel first.';
      menu.append(note);
    } else {
      for (const prompt of CONFIG.prompts) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.textContent = prompt.label;
        entry.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeMenus();
          startSession(item, button, prompt);
        });
        menu.append(entry);
      }
    }

    item.appendChild(menu);
  }

  function startSession(item, button, prompt) {
    const channel = currentChannel();
    button.dataset.busy = '1';
    showResult(item, `Starting ${prompt.label}…`, 'info');

    ask({
      op: 'start-session',
      promptKey: prompt.key,
      channel,
      sender: senderFor(item),
      text: messageText(item),
      thread: threadContext(item),
      permalink: messageMeta(item).permalink,
      ts: messageMeta(item).ts,
    }).then((res) => {
      if (res.error) {
        showResult(item, res.hint ? `${res.error} ${res.hint}` : res.error, 'error');
        return;
      }
      const base = `${prompt.label} → ${res.branch}`;
      showResult(item, res.warning ? `${base} — ${res.warning}` : base, 'info');
    }).catch((err) => {
      showResult(item, err.message, 'error');
    }).finally(() => {
      delete button.dataset.busy;
    });
  }

  /**
   * Results hang off the row, which the virtual list recycles, so they are
   * addressed by the message signature and dropped when the row moves on.
   */
  function showResult(item, text, kind) {
    let line = item.querySelector(':scope > .sidequest-result');
    if (!line) {
      line = document.createElement('div');
      line.className = 'sidequest-result';
      item.appendChild(line);
    }
    line.dataset.kind = kind;
    line.dataset.sig = rowSignature(item);
    line.textContent = text;
  }

  function decorate(item) {
    const signature = rowSignature(item);

    // The row was recycled into a different message: anything we drew about
    // the old one is now a lie, so take it down.
    const stale = item.querySelector(':scope > .sidequest-result');
    if (stale && stale.dataset.sig !== signature) stale.remove();
    if (item.getAttribute(ATTR_ROW) !== signature) {
      item.querySelector(':scope > .sidequest-menu')?.remove();
      item.setAttribute(ATTR_ROW, signature);
    }

    let button = item.querySelector(':scope > .sidequest-launch');
    if (!button) {
      button = buildLaunchButton();
      item.appendChild(button);
    }

    const linked = isLinked(currentChannel()) ? '1' : '0';
    if (button.dataset.linked !== linked) button.dataset.linked = linked;
  }

  /* ------------------------------------------------------- channel button */

  let channelButton = null;

  function buildChannelButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidequest-channel';

    const dot = document.createElement('span');
    dot.className = 'sidequest-dot';
    const label = document.createElement('span');
    label.className = 'sidequest-channel-label';
    button.append(dot, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      promptForRepo(button);
    });
    return button;
  }

  /*
   * Linking a channel to a repo needs a path, and the overlay has nowhere good
   * to browse the filesystem from. `prompt` is unglamorous but it is the one
   * thing that already exists, cannot be styled wrong, and puts the daemon in
   * charge of deciding whether the path is a real repo.
   */
  function promptForRepo(button) {
    const channel = button.dataset.channel;
    if (!channel) return;

    const current = CONFIG.repoLabels[channelKey(channel)] || '';
    const answer = window.prompt(
      `Repo for #${channel}\n\nAbsolute path to a git checkout. Leave empty to unlink.`,
      current ? '' : '',
    );
    // Cancelled: leave the link exactly as it was.
    if (answer === null) return;

    button.dataset.busy = '1';
    ask({ op: 'link-repo', channel, repoPath: answer }).then((res) => {
      if (res.error) {
        window.alert(res.hint ? `${res.error}\n\n${res.hint}` : res.error);
      }
    }).catch((err) => {
      log('link failed', err.message);
    }).finally(() => {
      delete button.dataset.busy;
      refreshChannelButton();
    });
  }

  function refreshChannelButton() {
    const channel = currentChannel();

    // Nothing identifiable on screen — a preferences pane, or Slack still
    // starting. A button that cannot say which channel it means should not be
    // offering to link one.
    if (!channel) {
      channelButton?.remove();
      return;
    }
    const anchor = document.querySelector(SEL.channel);
    if (!anchor) {
      channelButton?.remove();
      return;
    }
    const host = anchor.closest(SEL.header) || anchor.parentElement;
    if (!host) return;

    if (!channelButton) channelButton = buildChannelButton();
    // Slack rebuilds the header on every channel switch, taking the button
    // with it. Putting it back is one append, inside the observer callback, so
    // it is back before the frame is painted.
    if (channelButton.parentElement !== host) host.appendChild(channelButton);
    if (channelButton.dataset.channel !== channel) channelButton.dataset.channel = channel;

    // A click in flight owns the wording until the daemon answers.
    if (channelButton.dataset.busy === '1') return;

    const linked = isLinked(channel);
    const repo = CONFIG.repoLabels[channelKey(channel)] || '';
    const flag = linked ? '1' : '0';
    if (channelButton.dataset.linked !== flag) channelButton.dataset.linked = flag;

    const label = channelButton.querySelector('.sidequest-channel-label');
    const text = linked ? repo || 'Linked' : 'Link a repo';
    if (label.textContent !== text) label.textContent = text;

    const title = linked
      ? `#${channel} starts Claude Code sessions in ${repo} — click to change or unlink`
      : `Link #${channel} to a git repo so messages can start Claude Code sessions`;
    if (channelButton.title !== title) channelButton.title = title;
  }

  /* ------------------------------------------------------------ reconcile */

  const dirty = new Set();

  function flush() {
    ensureStyle();
    for (const item of dirty) {
      if (!item.isConnected) continue;
      try {
        decorate(item);
      } catch (err) {
        log('decorate failed', err.message);
      }
    }
    dirty.clear();
    try {
      refreshChannelButton();
    } catch (err) {
      log('channel button failed', err.message);
    }
  }

  function sweep() {
    document.querySelectorAll(SEL.item).forEach((item) => dirty.add(item));
    flush();
  }

  function collect(node) {
    if (!node || node.nodeType !== 1) return;
    // Our own UI mutating must not schedule another pass over itself.
    if (node.closest?.('.sidequest-menu, .sidequest-launch, .sidequest-result, .sidequest-channel')) return;
    const item = node.closest?.(SEL.item);
    if (item) {
      dirty.add(item);
      return;
    }
    // A whole slice of the virtual list can land in one mutation.
    node.querySelectorAll?.(SEL.item).forEach((el) => dirty.add(el));
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      collect(rec.target);
      rec.addedNodes.forEach(collect);
    }
    // Synchronous, so a recycled row never paints someone else's result line.
    flush();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Clicking anywhere else dismisses an open menu.
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('.sidequest-menu, .sidequest-launch')) return;
    closeMenus();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  }, true);

  // Backstop: the virtual list sometimes settles without a mutation we see.
  setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log('sweep failed', err.message);
    }
  }, 2000);

  ensureStyle();
  sweep();
  log('overlay ready');
})();
