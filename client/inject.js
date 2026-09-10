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
  // What the overlay leaves between itself and anything of Slack's.
  const GAP = 8;

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    sender: '[data-qa="message_sender_name"]',
    rich: '.p-rich_text_section',
    channel: '[data-qa="channel_name"]',
    header: '[data-qa="channel_header"]',
    timestamp: 'a.c-timestamp',
  };

  /* Anything in the channel header that owns its own clicks. */
  const HEADER_CONTROLS = 'button, a, input, [role="button"]';

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

    /*
     * Every colour here is derived from what Slack hands down. The font and
     * the text colour arrive by inheritance on the host; --sq-bg is measured
     * off Slack's own message list in refreshTheme, because the host is
     * transparent and a background cannot be inherited. Nothing is hardcoded
     * per theme, so the overlay follows a workspace from Aubergine to dark
     * without being told which one it is on.
     */
    :host {
      --sq-line: color-mix(in srgb, currentColor 16%, transparent);
      --sq-line-hover: color-mix(in srgb, currentColor 34%, transparent);
      --sq-wash: color-mix(in srgb, currentColor 8%, transparent);
      --sq-shade: color-mix(in srgb, currentColor 20%, transparent);
      --sq-ok: #2eb67d;
      --sq-bad: #e01e5a;
    }

    .sq-pill {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 6px;
      max-width: 40vw; height: 22px; padding: 0 8px;
      font-family: inherit; font-size: 12px; line-height: 20px; font-weight: 500;
      color: inherit; white-space: nowrap;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 6px;
      box-shadow: 0 1px 3px var(--sq-shade);
      cursor: pointer; user-select: none; pointer-events: auto;
    }
    /* The chrome stays crisp and only the label is quiet, so the pill reads as
       one of Slack's own buttons instead of a faded sticker over the message. */
    .sq-pill > .sq-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: .72; }
    .sq-pill:hover { border-color: var(--sq-line-hover); background: var(--sq-wash); }
    .sq-pill:hover > .sq-label { opacity: 1; }
    .sq-pill[data-busy="1"] { opacity: .45; pointer-events: none; }
    /* Nowhere near enough room beside the channel name for a label: the dot
       alone, with the whole sentence still in the tooltip. */
    .sq-pill[data-compact="1"] { width: 22px; padding: 0; justify-content: center; }
    .sq-pill[data-compact="1"] > .sq-label { display: none; }

    .sq-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sq-ok); flex: 0 0 auto; }
    .sq-pill[data-linked="0"] .sq-dot { background: color-mix(in srgb, currentColor 45%, transparent); }

    .sq-menu {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: flex; flex-direction: column; gap: 1px;
      min-width: 180px; max-width: 264px; padding: 5px;
      font-family: inherit; color: inherit;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 8px;
      box-shadow: 0 8px 24px var(--sq-shade);
      pointer-events: auto;
    }
    .sq-menu button {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 6px 8px; margin: 0;
      font-family: inherit; font-size: 13px; line-height: 18px; font-weight: 400;
      color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-menu button:hover { background: var(--sq-wash); }
    .sq-menu-link { font-weight: 500; }
    /* A sentence, not a menu item. It wraps inside the menu rather than
       stretching it into a bar across the message underneath. */
    .sq-note {
      padding: 6px 8px 4px; font-size: 12px; line-height: 16px; opacity: .7;
      white-space: normal; overflow-wrap: break-word;
    }

    /* The result reads as an annotation on the message it came from: drawn
       inside that row, along its bottom edge, tucked against the right where a
       message leaves space. Its own row, not the next one — a line hung below
       the boundary covers the following message's timestamp. One line, so it
       covers nothing unasked; hovering it lets the whole thing wrap, which is
       what an error needs. */
    .sq-result {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      max-width: 60vw; padding: 1px 8px;
      font-family: inherit; font-size: 11px; line-height: 16px;
      color: inherit; opacity: .9;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 5px;
      cursor: pointer; pointer-events: auto;
    }
    .sq-result:hover {
      white-space: normal; overflow: visible; opacity: 1;
      box-shadow: 0 6px 18px var(--sq-shade);
    }
    /* An error is the one line worth interrupting for, so it gets an edge as
       well as a colour — a red-on-dark word alone is easy to scroll past. */
    .sq-result[data-kind="error"] {
      color: var(--sq-bad); opacity: 1;
      border-color: color-mix(in srgb, var(--sq-bad) 40%, transparent);
      border-left: 2px solid var(--sq-bad);
    }

    .sq-panel {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: flex; flex-direction: column; gap: 7px;
      width: 340px; padding: 12px;
      font-family: inherit; color: inherit;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 8px;
      box-shadow: 0 10px 28px var(--sq-shade);
      pointer-events: auto;
    }
    .sq-panel-title { font-size: 13px; line-height: 18px; font-weight: 700; }
    .sq-panel input {
      box-sizing: border-box; padding: 6px 8px;
      font-family: inherit; font-size: 12px; line-height: 18px;
      color: inherit; background: transparent;
      border: 1px solid var(--sq-line-hover); border-radius: 5px;
    }
    .sq-panel input:focus { border-color: currentColor; outline: none; }
    .sq-panel-note { font-size: 11px; line-height: 15px; opacity: .7; }
    .sq-panel-error { font-size: 11px; line-height: 15px; color: var(--sq-bad); }
    .sq-panel-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 1px; }
    .sq-panel-actions button {
      padding: 5px 12px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px; font-weight: 500;
      color: inherit; background: transparent;
      border: 1px solid var(--sq-line-hover); border-radius: 5px; cursor: pointer;
    }
    .sq-panel-actions button:hover { background: var(--sq-wash); }
    .sq-panel-actions button[data-primary="1"] {
      color: #fff; background: #007a5a; border-color: #007a5a;
    }
    .sq-panel-actions button[data-primary="1"]:hover { background: #148567; }
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
  let panelKeys = null;
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
    panelKeys = null;
    themeSig = '';
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

  /*
   * The host is transparent, so a background is the one thing the overlay
   * cannot inherit from Slack — and a hardcoded near-white one is unreadable
   * on a dark workspace under Slack's own light text. So the nearest opaque
   * background behind the message list is read off Slack's DOM and handed to
   * the stylesheet as --sq-bg. Read, as ever, never written.
   */
  const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/;

  function parseColor(value) {
    const m = RGB.exec(String(value || ''));
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  }

  const isLight = (color) => color
    ? (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 > 0.6
    : false;

  function opaqueBackground(start) {
    let node = start;
    for (let hops = 0; node && hops < 30; hops += 1) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.9) return `rgb(${color.r}, ${color.g}, ${color.b})`;
      node = node.parentElement;
    }
    return '';
  }

  let themeSig = '';

  function refreshTheme() {
    const anchor = document.querySelector(SEL.content)
      || document.querySelector(SEL.channel)
      || document.body;
    const text = getComputedStyle(host).color;
    // Nothing opaque to be found: light text means a dark workspace, so the
    // guess at least lands on the right side of legible.
    const bg = opaqueBackground(anchor) || (isLight(parseColor(text)) ? '#1a1d21' : '#ffffff');
    const sig = `${bg}|${text}`;
    if (sig === themeSig) return;
    themeSig = sig;
    host.style.setProperty('--sq-bg', bg);
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
    label.className = 'sq-label';
    label.textContent = 'Sidequest';
    button.append(dot, label);
    button.title = 'Start a Claude Code session from this message';

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
        ? `No repo is linked to #${channel} yet.`
        : 'Open a channel to start a session.';
      menu.append(note);

      // Sending the reader off to hunt for another button is a dead end, and
      // in a narrow window that button may have no room to be shown at all.
      // The way out of the menu is in the menu.
      if (channel) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'sq-menu-link';
        link.textContent = 'Link a repo…';
        link.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          openPanel();
          schedule();
        });
        menu.append(link);
      }
    } else {
      for (const prompt of CONFIG.prompts) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = 'sq-menu-prompt';
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
    label.className = 'sq-label sq-channel-label';
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
    panelKeys = null;
  }

  /**
   * The panel's input, while it holds the keyboard. Focus inside a shadow root
   * reads as the host from the outside, so this is the only way to tell an
   * event meant for the path box from one meant for Slack.
   */
  function panelInput() {
    if (!panelEl || !ui) return null;
    const active = ui.activeElement;
    return active && active.tagName === 'INPUT' && panelEl.contains(active) ? active : null;
  }

  /** A path is one line, whatever shape the clipboard carried it in. */
  function insertText(input, text) {
    const flat = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!flat) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(flat, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    submit.dataset.primary = '1';
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
    // Reached from the window-level claim in the triggers section rather than
    // from a listener here: that claim has to stop the event before Slack's
    // own document listeners see it, which is early enough that it never
    // reaches this input at all.
    panelKeys = (event) => {
      if (event.key === 'Enter') send();
      if (event.key === 'Escape') { closePanel(); schedule(); }
    };

    panelEl = panel;
    ui.append(panel);
    input.focus();
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
    const pill = channelBtn.getBoundingClientRect();
    if (pill.width > 0) {
      placeAt(panelEl, pill.left, pill.bottom + 6);
      return;
    }
    // The panel was opened from the message menu, with no pill to hang off.
    const header = document.querySelector(SEL.header);
    const top = header ? header.getBoundingClientRect().bottom + 8 : 12;
    placeAt(panelEl, (window.innerWidth - panelEl.offsetWidth) / 2, top);
  }

  /* ------------------------------------------------------------- placement */

  let hoverRow = null;
  let frame = 0;
  let tick = 0;

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
    // Colours only change when someone changes theme; a computed-style read on
    // every frame would be waste.
    if (!themeSig || tick % 8 === 0) refreshTheme();
    tick += 1;
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
      // Slack's own hover actions and an unread divider's "New" label both live
      // at a row's top-right corner, so the pill takes the bottom-right and
      // leaves them clickable.
      const bottom = Math.min(activeRect.bottom, clip.bottom);
      placeAt(
        launchBtn,
        activeRect.right - launchBtn.offsetWidth - GAP,
        bottom - launchBtn.offsetHeight - 3,
      );
    } else {
      hide(launchBtn);
      if (menuEl) closeMenu();
    }

    if (menuEl && activeRect) {
      show(menuEl);
      // Hung off the pill like any menu, rather than dropped across the message
      // it was opened from, and flipped above when the row is near the bottom.
      const pill = launchBtn.getBoundingClientRect();
      const corner = {
        right: activeRect.right - GAP,
        top: activeRect.bottom,
        bottom: activeRect.bottom,
      };
      const anchor = pill.width > 0 ? pill : corner;
      const below = anchor.bottom + 4;
      const top = below + menuEl.offsetHeight > window.innerHeight - 4
        ? anchor.top - menuEl.offsetHeight - 4
        : below;
      placeAt(menuEl, anchor.right - menuEl.offsetWidth, top);
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
      if (el.textContent !== entry.text) {
        el.textContent = entry.text;
        // The line is one line wide; the tooltip is where all of it lives.
        el.title = `${entry.text}\n\nClick to dismiss.`;
      }
      if (el.dataset.kind !== entry.kind) el.dataset.kind = entry.kind;

      const rect = row.getBoundingClientRect();
      if (clip && onScreen(rect, clip)) {
        show(el);
        // The row button shares this corner while the pointer is on the
        // message, so the line makes room for it rather than sitting under it.
        const reserve = row === activeRow && !launchBtn.classList.contains('sq-off')
          ? launchBtn.offsetWidth + GAP
          : 0;
        const content = row.querySelector(SEL.content);
        const indent = content ? content.getBoundingClientRect().left : rect.left + 16;
        const right = rect.right - GAP - reserve;
        el.style.maxWidth = `${Math.max(160, Math.round((right - indent) * 0.75))}px`;
        placeAt(
          el,
          right - el.offsetWidth,
          Math.min(rect.bottom, clip.bottom) - el.offsetHeight - 3,
        );
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

  /*
   * Slack routes clipboard and keyboard events into its own composer from
   * listeners on the document, and an event out of the shadow root arrives
   * there retargeted to the host — so a paste into the panel's path box reads
   * to Slack like a paste into the channel, and the box stays empty. Nothing
   * bound inside the shadow root can get in front of that: capture runs
   * outermost first, and the only place earlier than a document listener is
   * `window`. While the box holds focus the overlay claims these events there
   * and stops them dead, leaving the browser's own default — insert at the
   * caret — to do the work.
   *
   * Stopping an event during capture means it never reaches the input either,
   * so anything the panel does with a key is done from here.
   */
  let pasteTicket = 0;

  for (const type of ['paste', 'copy', 'cut']) {
    window.addEventListener(type, (event) => {
      if (!panelInput()) return;
      if (event.type === 'paste') pasteTicket = 0;
      event.stopImmediatePropagation();
    }, true);
  }

  window.addEventListener('keydown', (event) => {
    const input = panelInput();
    if (!input) return;
    // The same stop keeps a keystroke meant for the path box from also being a
    // Slack shortcut, and keeps anything downstream from cancelling the key's
    // own paste.
    event.stopImmediatePropagation();
    panelKeys?.(event);
    if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'v') return;

    // A paste normally follows as that key's default action, and the handler
    // above clears the ticket when it does. Where the app takes the shortcut
    // for itself and no paste ever arrives, read the clipboard directly.
    const ticket = ++pasteTicket;
    setTimeout(() => {
      if (pasteTicket !== ticket || panelInput() !== input) return;
      Promise.resolve(navigator.clipboard?.readText?.()).then((text) => {
        if (text && pasteTicket === ticket && panelInput() === input) insertText(input, text);
      }).catch(() => {});
    }, 0);
  }, true);

  for (const type of ['keypress', 'keyup']) {
    window.addEventListener(type, (event) => {
      if (panelInput()) event.stopImmediatePropagation();
    }, true);
  }

  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  // Slack moves rows for reasons no event of ours sees: a message arrives, the
  // list settles, a channel switch rebuilds the header.
  setInterval(schedule, TICK_MS);

  schedule();
  log('overlay ready');
})();
