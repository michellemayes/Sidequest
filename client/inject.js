/*
 * sidequest overlay — runs inside the Slack desktop app's renderer.
 *
 * Injected over CDP by src/cdp/attacher.ts, which also installs the
 * __sidequestAsk binding this talks to. Nothing here reaches the network; every
 * request goes down to the local daemon and comes back through
 * __sidequestResult.
 *
 * Two pieces of UI:
 *   1. A button on the message under the pointer, opening the three prompts.
 *   2. A button beside the channel name showing which repo the channel is on.
 *
 * Both are drawn in a layer of sidequest's own: one zero-sized, pointer-events:
 * none host at the end of <body>, with a shadow root holding every element and
 * the only stylesheet. Slack's own DOM is never written to — no children, no
 * attributes, no styles, and no rule in here can match a Slack element. That is
 * deliberate. Slack's lists are virtualised and their rows are measured and
 * recycled, so a child appended into a row, or a `position` overridden on one,
 * changes how Slack lays out the app around it. `[data-qa="virtual-list-item"]`
 * is also not just messages: the sidebar, the DM list and search results are
 * virtual lists too, so anything drawn from that selector alone lands all over
 * the app. Rows are matched on a message's own content, and only read.
 *
 * Everything anchored to a message is positioned from that row's rectangle on
 * each frame and keyed by the message it belongs to, so a recycled row drops
 * what was drawn for its previous occupant instead of relabelling it.
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
  const LAYER_ID = 'sidequest-layer';
  const REQUEST_TIMEOUT_MS = 120000;
  // A result outlives a scroll away and back, not a working session.
  const RESULT_TTL_MS = 10 * 60 * 1000;
  const MAX_RESULTS = 20;
  const TICK_MS = 250;

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    sender: '[data-qa="message_sender_name"]',
    rich: '.p-rich_text_section',
    channel: '[data-qa="channel_name"]',
    timestamp: 'a.c-timestamp',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[sidequest]', ...args); };

  /* ---------------------------------------------------------------- styles */

  /*
   * Scoped to the shadow root, so none of it can reach a Slack element even by
   * accident. Colours and font come from Slack through inheritance on the
   * host, which is how the overlay follows the workspace theme without reading
   * anything about it.
   */
  const CSS = `
    .sq-off { display: none !important; }

    .sq-pill {
      position: fixed; left: 0; top: 0;
      display: inline-flex; align-items: center; gap: 5px;
      max-width: 40vw; padding: 2px 8px;
      font-family: inherit; font-size: 11px; line-height: 16px; font-weight: 500;
      color: inherit; opacity: .75; white-space: nowrap;
      background: var(--saf-background, rgba(255,255,255,.96));
      border: 1px solid rgba(127,127,127,.35); border-radius: 7px;
      cursor: pointer; user-select: none; pointer-events: auto;
    }
    .sq-pill:hover { opacity: 1; border-color: rgba(127,127,127,.6); }
    .sq-pill[data-busy="1"] { opacity: .4; pointer-events: none; }
    .sq-pill > span { overflow: hidden; text-overflow: ellipsis; }

    .sq-dot { width: 6px; height: 6px; border-radius: 50%; background: #2eb67d; flex: 0 0 auto; }
    .sq-pill[data-linked="0"] .sq-dot { background: #8d8d8d; }

    .sq-menu {
      position: fixed; left: 0; top: 0;
      display: flex; flex-direction: column; min-width: 176px; padding: 4px;
      font-family: inherit; color: inherit;
      background: var(--saf-background, #fff);
      border: 1px solid rgba(127,127,127,.35); border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      pointer-events: auto;
    }
    .sq-menu button {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; margin: 0;
      font-family: inherit; font-size: 13px; line-height: 18px;
      color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-menu button:hover { background: rgba(127,127,127,.14); }
    .sq-note { padding: 6px 8px; font-size: 11px; line-height: 15px; opacity: .7; }

    /* The result reads as an annotation on the message it came from: drawn at
       that row's bottom edge, on the same indent as its text. */
    .sq-result {
      position: fixed; left: 0; top: 0;
      max-width: 60vw; padding: 1px 7px;
      font-family: inherit; font-size: 11px; line-height: 16px;
      color: inherit; opacity: .85;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: var(--saf-background, rgba(255,255,255,.96));
      border: 1px solid rgba(127,127,127,.25); border-radius: 6px;
      cursor: pointer; pointer-events: auto;
    }
    .sq-result[data-kind="error"] { color: #e01e5a; opacity: 1; }

    .sq-panel {
      position: fixed; left: 0; top: 0;
      display: flex; flex-direction: column; gap: 6px;
      width: 340px; padding: 10px;
      font-family: inherit; color: inherit;
      background: var(--saf-background, #fff);
      border: 1px solid rgba(127,127,127,.35); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.22);
      pointer-events: auto;
    }
    .sq-panel-title { font-size: 12px; line-height: 16px; font-weight: 700; }
    .sq-panel input {
      padding: 5px 7px;
      font-family: inherit; font-size: 12px; line-height: 18px;
      color: inherit; background: transparent;
      border: 1px solid rgba(127,127,127,.45); border-radius: 5px;
    }
    .sq-panel-note { font-size: 11px; line-height: 15px; opacity: .7; }
    .sq-panel-error { font-size: 11px; line-height: 15px; color: #e01e5a; }
    .sq-panel-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .sq-panel-actions button {
      padding: 4px 10px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px; font-weight: 500;
      color: inherit; background: transparent;
      border: 1px solid rgba(127,127,127,.4); border-radius: 5px; cursor: pointer;
    }
    .sq-panel-actions button:hover { background: rgba(127,127,127,.14); }
    .sq-panel[data-busy="1"] { opacity: .5; pointer-events: none; }
  `;

  /* ----------------------------------------------------------------- layer */

  let host = null;
  let ui = null;
  let launchBtn = null;
  let channelBtn = null;
  let menuEl = null;
  let menuRow = null;
  let menuSig = '';
  let panelEl = null;
  const resultEls = new Map();

  /** Everything drawn lives in here, so losing the host means losing all of it. */
  function resetLayer() {
    ui = null;
    launchBtn = null;
    channelBtn = null;
    menuEl = null;
    menuRow = null;
    menuSig = '';
    panelEl = null;
    resultEls.clear();
  }

  function ensureLayer() {
    if (host && !host.isConnected) {
      host = null;
      resetLayer();
    }
    if (host && ui) return true;

    const parent = document.body || document.documentElement;
    if (!parent) return false;

    host = document.createElement('div');
    host.id = LAYER_ID;
    // Zero-sized, inert and last: the layer occupies nothing Slack lays out,
    // and takes part in no hit test of Slack's.
    host.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'margin:0', 'padding:0', 'border:0',
      'overflow:visible', 'pointer-events:none', 'z-index:2147483000',
    ].join(';');
    ui = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    launchBtn = buildLaunchButton();
    channelBtn = buildChannelButton();
    ui.append(style, launchBtn, channelBtn);

    parent.appendChild(host);
    // A handle for the tests and for anyone poking at the overlay from Slack's
    // devtools console.
    window.__SIDEQUEST_UI__ = ui;
    return true;
  }

  const show = (el) => el.classList.remove('sq-off');
  const hide = (el) => el.classList.add('sq-off');

  /** Viewport coordinates, kept on screen. Measured after the element is shown. */
  function placeAt(el, left, top) {
    const maxLeft = Math.max(4, window.innerWidth - el.offsetWidth - 4);
    const maxTop = Math.max(4, window.innerHeight - el.offsetHeight - 4);
    el.style.left = `${Math.round(Math.min(Math.max(4, left), maxLeft))}px`;
    el.style.top = `${Math.round(Math.min(Math.max(4, top), maxTop))}px`;
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
    schedule();
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
   * The sidebar, the DM list and search results are virtual lists too, so a
   * row only counts as a message if it carries a message's own content.
   */
  function isMessageRow(item) {
    return Boolean(item && item.querySelector && item.querySelector(SEL.content));
  }

  function messageRows() {
    const rows = [];
    document.querySelectorAll(SEL.item).forEach((item) => {
      if (isMessageRow(item)) rows.push(item);
    });
    return rows;
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
    const rows = messageRows();
    const index = rows.indexOf(item);
    if (index === -1) return [];
    return rows
      .slice(Math.max(0, index - 10), index)
      .map((row) => ({ author: senderFor(row), text: messageText(row) }))
      .filter((m) => m.text.length > 0);
  }

  /**
   * What the anchored UI is clipped to: a pill for a row scrolled up behind
   * the channel header must not hang there in mid-air.
   */
  let scroller = null;

  function clipRect(row) {
    if (!scroller || !scroller.isConnected || !scroller.contains(row)) {
      scroller = scrollParent(row);
    }
    if (scroller) return scroller.getBoundingClientRect();
    return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  }

  function scrollParent(el) {
    let node = el?.parentElement;
    for (let hops = 0; node && hops < 20; hops += 1) {
      const overflow = getComputedStyle(node).overflowY;
      if (/(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  const onScreen = (rect, clip) => rect.bottom > clip.top + 4 && rect.top < clip.bottom - 4;

  /* ------------------------------------------------------------ row button */

  function buildLaunchButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sq-pill sq-launch sq-off';

    const dot = document.createElement('span');
    dot.className = 'sq-dot';
    const label = document.createElement('span');
    label.textContent = 'Sidequest';
    button.append(dot, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
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
  }

  function openMenu(row) {
    closeMenu();
    closePanel();

    const menu = document.createElement('div');
    menu.className = 'sq-menu';
    const channel = currentChannel();

    if (!isLinked(channel)) {
      const note = document.createElement('div');
      note.className = 'sq-note';
      note.textContent = channel
        ? `#${channel} has no repo yet — use the button beside the channel name.`
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
          const target = menuRow;
          closeMenu();
          if (target && target.isConnected) startSession(target, prompt);
          schedule();
        });
        menu.append(entry);
      }
    }

    menuEl = menu;
    menuRow = row;
    menuSig = rowSignature(row);
    ui.append(menu);
    schedule();
  }

  function startSession(row, prompt) {
    // Read everything now: the row can be recycled long before the daemon
    // answers, and the answer belongs to the message that was clicked.
    const sig = rowSignature(row);
    const meta = messageMeta(row);
    const payload = {
      op: 'start-session',
      promptKey: prompt.key,
      channel: currentChannel(),
      sender: senderFor(row),
      text: messageText(row),
      thread: threadContext(row),
      permalink: meta.permalink,
      ts: meta.ts,
    };

    launchBtn.dataset.busy = '1';
    setResult(sig, `Starting ${prompt.label}…`, 'info');

    ask(payload).then((res) => {
      if (res.error) {
        setResult(sig, res.hint ? `${res.error} ${res.hint}` : res.error, 'error');
        return;
      }
      const base = `${prompt.label} → ${res.branch}`;
      setResult(sig, res.warning ? `${base} — ${res.warning}` : base, 'info');
    }).catch((err) => {
      setResult(sig, err.message, 'error');
    }).finally(() => {
      delete launchBtn.dataset.busy;
      schedule();
    });
  }

  /* ---------------------------------------------------------------- results */

  /** Keyed by message, not by row, so scrolling away and back keeps the line. */
  const results = new Map();

  function setResult(sig, text, kind) {
    if (!sig) return;
    results.delete(sig);
    results.set(sig, { text, kind, at: Date.now() });
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
    schedule();
  }

  function pruneResults() {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [sig, entry] of results) {
      if (entry.at < cutoff) results.delete(sig);
    }
  }

  function buildResult(sig) {
    const el = document.createElement('div');
    el.className = 'sq-result';
    el.title = 'Click to dismiss';
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      results.delete(sig);
      schedule();
    });
    return el;
  }

  /* -------------------------------------------------------- channel button */

  function buildChannelButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sq-pill sq-channel sq-off';

    const dot = document.createElement('span');
    dot.className = 'sq-dot';
    const label = document.createElement('span');
    label.className = 'sq-channel-label';
    button.append(dot, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panelEl) closePanel();
      else openPanel();
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
  }

  function openPanel() {
    closeMenu();
    closePanel();

    const channel = currentChannel();
    if (!channel) return;
    const current = CONFIG.repoLabels[channelKey(channel)] || '';

    const panel = document.createElement('div');
    panel.className = 'sq-panel';

    const title = document.createElement('div');
    title.className = 'sq-panel-title';
    title.textContent = `Repo for #${channel}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = '/Users/you/code/checkout';

    const note = document.createElement('div');
    note.className = 'sq-panel-note';
    note.textContent = current
      ? `Linked to ${current}. Enter a new path, or leave empty to unlink.`
      : 'Absolute path to a git checkout.';

    const error = document.createElement('div');
    error.className = 'sq-panel-error sq-off';

    const actions = document.createElement('div');
    actions.className = 'sq-panel-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = current ? 'Save' : 'Link';
    actions.append(cancel, submit);

    panel.append(title, input, note, error, actions);

    const send = () => {
      panel.dataset.busy = '1';
      hide(error);
      ask({ op: 'link-repo', channel, repoPath: input.value }).then((res) => {
        if (res.error) {
          error.textContent = res.hint ? `${res.error} — ${res.hint}` : res.error;
          show(error);
          delete panel.dataset.busy;
          input.focus();
          return;
        }
        closePanel();
      }).catch((err) => {
        error.textContent = err.message;
        show(error);
        delete panel.dataset.busy;
      }).finally(() => {
        schedule();
      });
    };

    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      schedule();
    });
    submit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      send();
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') send();
      if (event.key === 'Escape') { closePanel(); schedule(); }
    });

    panelEl = panel;
    ui.append(panel);
    input.focus();
    schedule();
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
    const repo = CONFIG.repoLabels[channelKey(channel)] || '';
    const flag = linked ? '1' : '0';
    if (channelBtn.dataset.linked !== flag) channelBtn.dataset.linked = flag;

    const label = channelBtn.querySelector('.sq-channel-label');
    const text = linked ? repo || 'Linked' : 'Link a repo';
    if (label.textContent !== text) label.textContent = text;

    const title = linked
      ? `#${channel} starts Claude Code sessions in ${repo} — click to change or unlink`
      : `Link #${channel} to a git repo so messages can start Claude Code sessions`;
    if (channelBtn.title !== title) channelBtn.title = title;

    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hide(channelBtn);
      return;
    }
    show(channelBtn);
    placeAt(channelBtn, rect.right + 8, rect.top + (rect.height - channelBtn.offsetHeight) / 2);

    if (panelEl) {
      const pill = channelBtn.getBoundingClientRect();
      placeAt(panelEl, pill.left, pill.bottom + 6);
    }
  }

  /* ------------------------------------------------------------- placement */

  let hoverRow = null;
  let frame = 0;

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      try {
        place();
      } catch (err) {
        log('placement failed', err.message);
      }
    });
  }

  function place() {
    if (!ensureLayer()) return;
    pruneResults();

    const rows = messageRows();
    const bySig = new Map();
    for (const row of rows) {
      const sig = rowSignature(row);
      if (sig && !bySig.has(sig)) bySig.set(sig, row);
    }
    const clip = rows.length > 0 ? clipRect(rows[0]) : null;

    // A recycled row is a different message now; the menu it opened is void.
    if (menuRow && (!menuRow.isConnected || rowSignature(menuRow) !== menuSig)) closeMenu();
    if (hoverRow && !hoverRow.isConnected) hoverRow = null;

    const activeRow = menuRow || hoverRow;
    const activeRect = activeRow ? activeRow.getBoundingClientRect() : null;

    if (activeRect && clip && onScreen(activeRect, clip)) {
      const flag = isLinked(currentChannel()) ? '1' : '0';
      if (launchBtn.dataset.linked !== flag) launchBtn.dataset.linked = flag;
      show(launchBtn);
      placeAt(launchBtn, activeRect.right - launchBtn.offsetWidth - 8, activeRect.top + 2);
    } else {
      hide(launchBtn);
      if (menuEl) closeMenu();
    }

    if (menuEl && activeRect) {
      show(menuEl);
      placeAt(menuEl, activeRect.right - menuEl.offsetWidth - 8, activeRect.top + 26);
    }

    for (const [sig, el] of resultEls) {
      if (!results.has(sig) || !bySig.has(sig)) {
        el.remove();
        resultEls.delete(sig);
      }
    }
    for (const [sig, entry] of results) {
      const row = bySig.get(sig);
      if (!row) continue;
      let el = resultEls.get(sig);
      if (!el) {
        el = buildResult(sig);
        resultEls.set(sig, el);
        ui.append(el);
      }
      if (el.textContent !== entry.text) el.textContent = entry.text;
      if (el.dataset.kind !== entry.kind) el.dataset.kind = entry.kind;

      const rect = row.getBoundingClientRect();
      if (clip && onScreen(rect, clip)) {
        show(el);
        const content = row.querySelector(SEL.content);
        const left = content ? content.getBoundingClientRect().left : rect.left + 16;
        placeAt(el, left, rect.bottom - 6);
      } else {
        hide(el);
      }
    }

    refreshChannelButton();
  }

  /* -------------------------------------------------------------- triggers */

  const fromOverlay = (target) => Boolean(
    host && target && target.nodeType === 1 && (target === host || host.contains(target)),
  );

  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    // Events out of the shadow root arrive retargeted to the host, so hovering
    // the overlay's own UI leaves the row it belongs to selected.
    if (fromOverlay(target)) return;
    const row = target.closest?.(SEL.item);
    const next = row && isMessageRow(row) ? row : null;
    if (next === hoverRow) return;
    hoverRow = next;
    schedule();
  }, true);

  document.addEventListener('mouseleave', (event) => {
    if (event.target !== document && event.target !== document.documentElement) return;
    hoverRow = null;
    schedule();
  }, true);

  document.addEventListener('click', (event) => {
    if (fromOverlay(event.target)) return;
    closeMenu();
    closePanel();
    schedule();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMenu();
    closePanel();
    schedule();
  }, true);

  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  // Slack moves rows for reasons no event of ours sees: a message arrives, the
  // list settles, a channel switch rebuilds the header.
  setInterval(schedule, TICK_MS);

  schedule();
  log('overlay ready');
})();
