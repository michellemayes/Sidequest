/*
 * sidequest overlay — runs inside the Slack desktop app's renderer.
 *
 * Injected over CDP by src/cdp/attacher.ts, which also installs the
 * __sidequestAsk binding this talks to. Every request goes down to the local
 * daemon and comes back through __sidequestResult. The one exception is the
 * thread reply a session can post when settings.autoReply is on, which goes
 * to Slack's own API as you (see postReply).
 *
 * Two pieces of UI:
 *   1. A button on the message under the pointer, opening the prompts —
 *      or, in a channel with no repo yet, the repos that look like its own.
 *   2. A button beside the channel name showing which repo the channel is on —
 *      or repos: a channel can have several, and the menu then asks which.
 * And three that follow from them: a line on a message while its session
 * starts, a quiet mark on every message that already has one (click it to be
 * back in that session), and a toast when a session lands.
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
    lastRepos: {},
    agentLabel: 'Claude Code',
    sessions: {},
    stats: { total: 0, today: 0, streak: 0 },
    verbose: false,
  }, window.__SIDEQUEST_CONFIG || {});

  const ASK = '__sidequestAsk';
  const LAYER_ID = 'sidequest-layer';
  const REQUEST_TIMEOUT_MS = 120000;
  // A result outlives a scroll away and back, not a working session.
  const RESULT_TTL_MS = 10 * 60 * 1000;
  const MAX_RESULTS = 20;
  /* The prompt that works a Linear issue; shown only when a message links one. */
  const LINEAR_KEY = 'linear';
  const ASK_KEY = 'ask';
  const TICK_MS = 250;
  const TOAST_MS = 5200;
  /* Suggestions shown in the message menu for a channel with no repo. */
  const MENU_SUGGESTIONS = 3;
  const PANEL_SUGGESTIONS = 6;
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

  /* The Sidequest mark: a little sparkle badge, inlined so the overlay needs
     no assets. Also saved as assets/icon.svg for the README. Each copy gets
     its own gradient id: url(#id) resolves to the first match in the document,
     and Chrome drops gradients defined inside a display:none subtree (compact
     pills hide their icon), which would blank every other icon. */
  let iconSeq = 0;
  const iconSvg = () => {
    const id = `sq-icon-grad-${++iconSeq}`;
    return '<svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true">' +
      `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
      '<stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/>' +
      '</linearGradient></defs>' +
      `<rect x="4" y="4" width="56" height="56" rx="16" fill="url(#${id})"/>` +
      '<path d="M32 14c2.1 9.2 6.1 13.2 15.3 15.3-9.2 2.1-13.2 6.1-15.3 15.3' +
      '-2.1-9.2-6.1-13.2-15.3-15.3 9.2-2.1 13.2-6.1 15.3-15.3z" fill="#fff"/>' +
      '<circle cx="46.5" cy="17.5" r="3.4" fill="#fff" opacity=".9"/>' +
      '<circle cx="17.5" cy="46.5" r="2.6" fill="#fff" opacity=".75"/>' +
      '</svg>';
  };

  /* Prompts carry Slack shortcode names; the menu wants the glyph. */
  const GLYPHS = {
    mag: '🔍', mag_right: '🔎', wrench: '🔧', hammer: '🔨', eyes: '👀', bug: '🐛',
    rocket: '🚀', sparkles: '✨', memo: '📝', test_tube: '🧪', bulb: '💡', zap: '⚡',
    ticket: '🎫', speech_balloon: '💬',
  };
  const glyphFor = (emoji) => {
    const name = String(emoji || '').replace(/^:|:$/g, '');
    if (!name) return '✦';
    if (GLYPHS[name]) return GLYPHS[name];
    // Already a glyph rather than a shortcode.
    return /[^\x00-\x7f]/.test(name) ? name : '✦';
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
    .sq-icon { width: 14px; height: 14px; flex: 0 0 auto; display: inline-flex; }
    .sq-icon svg { display: block; }
    /* In compact mode the pill is a 22px dot-only button; the icon would not fit. */
    .sq-pill[data-compact="1"] > .sq-icon { display: none; }

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
    .sq-menu button:hover, .sq-menu button[data-active="1"] { background: var(--sq-wash); }
    .sq-menu-link { font-weight: 500; }
    /* The glyph and the key are drawn by CSS, so an entry's text is its label
       and nothing else. */
    .sq-menu-prompt::before {
      content: attr(data-glyph); flex: 0 0 18px; text-align: center;
    }
    .sq-menu-prompt::after {
      content: attr(data-key); margin-left: auto; min-width: 8px; padding: 0 4px;
      font-size: 10px; line-height: 15px; text-align: center; opacity: .5;
      border: 1px solid var(--sq-line); border-radius: 4px;
    }
    .sq-menu-reopen, .sq-menu-suggest { font-size: 12px !important; }
    .sq-menu-reopen > span, .sq-menu-suggest > span {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sq-menu-reopen > .sq-glyph, .sq-menu-suggest > .sq-glyph { flex: 0 0 18px; text-align: center; }
    .sq-sub { margin-left: auto; padding-left: 6px; font-size: 11px; opacity: .55; }
    .sq-menu-sep { height: 1px; margin: 4px 2px; background: var(--sq-line); }
    /* A channel with several repos: which one the prompts below run in. */
    .sq-repos { display: flex; flex-wrap: wrap; gap: 4px; padding: 3px 3px 5px; }
    .sq-menu .sq-repo {
      width: auto; padding: 1px 8px;
      font-size: 11px; line-height: 16px; font-weight: 500;
      border: 1px solid var(--sq-line); border-radius: 9px; opacity: .7;
    }
    .sq-menu .sq-repo:hover { opacity: 1; }
    .sq-menu .sq-repo[data-on="1"] {
      opacity: 1; color: #fff; background: #7c3aed; border-color: #7c3aed;
    }
    /* Ask trades the menu's entries for a box to type the question into. */
    .sq-menu[data-asking="1"] { width: 264px; gap: 6px; padding: 8px; }
    .sq-ask-title { font-size: 13px; line-height: 18px; font-weight: 700; }
    .sq-ask-input {
      box-sizing: border-box; width: 100%; min-height: 58px; max-height: 180px;
      padding: 6px 8px; resize: vertical;
      font-family: inherit; font-size: 12px; line-height: 17px;
      color: inherit; background: transparent;
      border: 1px solid var(--sq-line-hover); border-radius: 5px;
    }
    .sq-ask-input:focus { border-color: currentColor; outline: none; }
    .sq-ask-foot { display: flex; align-items: center; gap: 8px; }
    .sq-ask-hint { font-size: 11px; line-height: 15px; opacity: .6; }
    .sq-menu .sq-ask-send {
      width: auto; margin-left: auto; padding: 4px 12px;
      font-size: 12px; line-height: 16px; font-weight: 500;
      color: #fff; background: #007a5a;
    }
    .sq-menu .sq-ask-send:hover { background: #148567; }
    /* A sentence, not a menu item. It wraps inside the menu rather than
       stretching it into a bar across the message underneath. */
    .sq-note {
      padding: 6px 8px 4px; font-size: 12px; line-height: 16px; opacity: .7;
      white-space: normal; overflow-wrap: break-word;
    }

    /* The result reads as an annotation on the message it came from: drawn
       inside that row, along its bottom edge, tucked against the right where a
       message's last line leaves space — and on a line of its own under the
       text where it does not (see cornerSpot). One line, so it covers nothing
       unasked; hovering it lets the whole thing wrap, which is what an error
       needs. */
    .sq-result {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: flex; align-items: flex-start; gap: 6px;
      max-width: 60vw; padding: 0 4px 0 8px;
      font-family: inherit; font-size: 11px; line-height: 14px;
      color: inherit; opacity: .9;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 5px;
      cursor: pointer; pointer-events: auto;
    }
    .sq-result-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-result:hover { opacity: 1; box-shadow: 0 6px 18px var(--sq-shade); }
    .sq-result:hover .sq-result-text { white-space: normal; overflow: visible; }
    .sq-result-x {
      flex: 0 0 auto; padding: 0 3px; margin: 0;
      font: inherit; color: inherit; opacity: .45;
      background: transparent; border: 0; border-radius: 3px; cursor: pointer;
    }
    .sq-result-x:hover { opacity: 1; background: var(--sq-wash); }
    /* Working on it: the words shimmer rather than sit there looking done. */
    .sq-result[data-kind="busy"] .sq-result-text {
      background: linear-gradient(90deg, currentColor 35%, #a78bfa 50%, currentColor 65%);
      background-size: 250% 100%;
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: sq-shimmer 1.3s linear infinite;
    }

    /* A message that already has a session. Quiet until pointed at, and one
       click from being back in it. */
    .sq-mark {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 4px;
      max-width: 40vw; height: 16px; padding: 0 7px;
      font-family: inherit; font-size: 11px; line-height: 14px;
      color: inherit; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 9px;
      cursor: pointer; pointer-events: auto;
    }
    .sq-mark:hover { opacity: 1; border-color: var(--sq-line-hover); }
    .sq-mark::before { content: '✦'; color: #8b5cf6; }

    .sq-toast {
      position: fixed; left: 0; top: 0;
      box-sizing: border-box;
      display: flex; align-items: center; gap: 12px;
      max-width: 440px; padding: 10px 14px 10px 12px;
      font-family: inherit; color: inherit;
      background: var(--sq-bg, #fff);
      border: 1px solid var(--sq-line); border-radius: 10px;
      box-shadow: 0 12px 32px var(--sq-shade);
      cursor: pointer; pointer-events: auto;
      animation: sq-pop .34s cubic-bezier(.2, 1.5, .4, 1) both;
    }
    .sq-toast[data-leaving="1"] { animation: sq-fade .25s ease-in both; }
    .sq-toast-icon { position: relative; flex: 0 0 28px; width: 28px; height: 28px; display: inline-flex; }
    .sq-toast-icon svg { width: 28px; height: 28px; display: block; }
    .sq-toast-body { min-width: 0; display: flex; flex-direction: column; }
    .sq-toast-title { font-size: 13px; line-height: 18px; font-weight: 700; }
    .sq-toast-sub {
      font-size: 12px; line-height: 16px; opacity: .72;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sq-spark {
      position: absolute; left: 50%; top: 50%;
      width: 5px; height: 5px; margin: -2.5px; border-radius: 50%;
      background: var(--c, #a78bfa);
      animation: sq-burst .75s ease-out forwards;
    }
    @keyframes sq-burst {
      from { transform: rotate(var(--a)) translateX(4px) scale(1); opacity: 1; }
      to { transform: rotate(var(--a)) translateX(30px) scale(.2); opacity: 0; }
    }
    @keyframes sq-pop {
      from { transform: translateY(-8px) scale(.96); opacity: 0; }
      to { transform: none; opacity: 1; }
    }
    @keyframes sq-fade { to { transform: translateY(-4px); opacity: 0; } }
    @keyframes sq-shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .sq-toast, .sq-toast[data-leaving="1"], .sq-result-text { animation: none !important; }
      .sq-spark { display: none; }
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
    .sq-suggest-list { display: flex; flex-direction: column; gap: 1px; max-height: 204px; overflow-y: auto; }
    .sq-suggest {
      display: flex; align-items: baseline; gap: 8px;
      width: 100%; padding: 5px 8px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px;
      color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-suggest:hover, .sq-suggest[data-active="1"] { background: var(--sq-wash); }
    .sq-suggest-name { font-weight: 600; flex: 0 0 auto; }
    .sq-suggest-path { min-width: 0; opacity: .55; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-suggest[data-match="1"] .sq-suggest-name::after { content: ' ★'; color: #8b5cf6; }
    .sq-linked { display: flex; flex-direction: column; gap: 1px; }
    .sq-linked-row {
      display: flex; align-items: center; gap: 8px; padding: 3px 4px 3px 8px;
      font-size: 12px; line-height: 16px; border-radius: 5px;
    }
    .sq-linked-row:hover { background: var(--sq-wash); }
    .sq-linked-row::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--sq-ok); flex: 0 0 auto; }
    .sq-linked-name { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-linked-x {
      margin: 0 0 0 auto; padding: 0 5px;
      font: inherit; color: inherit; opacity: .45;
      background: transparent; border: 0; border-radius: 3px; cursor: pointer;
    }
    .sq-linked-x:hover { opacity: 1; background: var(--sq-wash); }
  `;

  /* ----------------------------------------------------------------- layer */

  let host = null;
  let ui = null;
  let launchBtn = null;
  let channelBtn = null;
  let menuEl = null;
  let menuRow = null;
  let menuSig = '';
  let menuIndex = -1;
  let panelEl = null;
  /** Keys for whichever text box holds the keyboard: the path box or the Ask box. */
  let boxKeys = null;
  let toastEl = null;
  let toastTimer = 0;
  const resultEls = new Map();
  const markEls = new Map();

  /** Everything drawn lives in here, so losing the host means losing all of it. */
  function resetLayer() {
    ui = null;
    launchBtn = null;
    channelBtn = null;
    menuEl = null;
    menuRow = null;
    menuSig = '';
    menuIndex = -1;
    panelEl = null;
    boxKeys = null;
    toastEl = null;
    themeSig = '';
    resultEls.clear();
    markEls.clear();
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

  /** The channel's repos by label, the default first. */
  function reposFor(channel) {
    const list = CONFIG.repoLabels[channelKey(channel)];
    if (Array.isArray(list)) return list;
    return list ? [String(list)] : [];
  }

  /* Which repo the reader picked per channel, for as long as Slack stays open. */
  const repoPicks = new Map();

  /**
   * The repo a session in this channel starts in: the one picked in the menu,
   * else the one the channel's last session used, else the channel's default.
   */
  function pickedRepo(channel) {
    const repos = reposFor(channel);
    const key = channelKey(channel);
    for (const choice of [repoPicks.get(key), CONFIG.lastRepos && CONFIG.lastRepos[key]]) {
      if (choice && repos.includes(choice)) return choice;
    }
    return repos[0] || '';
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

  /*
   * A Linear issue link, with its identifier. Mirrors LINEAR_ISSUE in
   * src/config/prompts.ts, which checks it again on the way in.
   */
  const LINEAR_ISSUE = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)[^\s<>|]*/gi;
  const MAX_TICKETS = 2;

  /**
   * The Linear issues a message links, first seen first. Read off the links'
   * own hrefs as well as the text, since a link can be labelled with anything.
   */
  function linearTickets(item) {
    const content = item.querySelector(SEL.content);
    if (!content) return [];
    const sources = Array.from(content.querySelectorAll('a[href]'), (a) => a.href);
    sources.push(messageText(item));
    const found = new Map();
    for (const source of sources) {
      for (const match of String(source).matchAll(LINEAR_ISSUE)) {
        const id = match[1].toUpperCase();
        if (!found.has(id)) found.set(id, { id, url: match[0] });
      }
    }
    return Array.from(found.values()).slice(0, MAX_TICKETS);
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

  /**
   * Where the words and pictures of a message actually are: one box per line
   * of text, plus images. The content element itself is no use for this — it
   * spans the full width of the row whether the last line is one word or
   * forty. Slack's screen-reader-only text is laid out somewhere invisible and
   * would read as ink that is not there, so it is skipped.
   */
  function inkOf(row) {
    const boxes = [];
    const content = row.querySelector(SEL.content);
    if (!content) return boxes;
    const range = document.createRange();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim() || node.parentElement?.closest('.offscreen')) continue;
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) {
        if (box.width > 1 && box.height > 1) boxes.push(box);
      }
    }
    content.querySelectorAll('img').forEach((img) => {
      const box = img.getBoundingClientRect();
      if (box.width > 1 && box.height > 1) boxes.push(box);
    });
    return boxes;
  }

  /**
   * Whether a box is open message list: every point sampled across it lands
   * on a list item, or on the list around them, and not on something Slack
   * floats over the list's bottom edge — the composer, the suggestion chips
   * above it, a "new messages" bar. The overlay's own layer is looked through.
   */
  function openList(row, left, top, width, height) {
    const xs = [left + 2, left + width / 2, left + width - 2];
    const ys = [top + 2, top + height - 2];
    for (const x of xs) {
      for (const y of ys) {
        const hit = document.elementsFromPoint(x, y).find((el) => el !== host);
        if (!hit) return false;
        if (!hit.closest(SEL.item) && !hit.contains(row)) return false;
      }
    }
    return true;
  }

  const overlaps = (a, left, top, width, height) => (
    a.bottom > top + 1 && a.top < top + height - 1 && a.right > left - GAP / 2 && a.left < left + width + GAP / 2
  );

  /**
   * Where to draw something at a row's bottom-right corner, `right` being
   * where its right edge falls. Beside the message's last line when the words
   * stop short of it; otherwise on a line of its own just under them, in the
   * gap before the next message. When that gap is not there — the last
   * message in a channel or thread sits right on the composer — it stays in
   * the row rather than hanging over the composer: cut short to fit beside
   * the last line when `fit` is 'shrink', and otherwise over the end of the
   * words as a last resort. `taken` is what the overlay already put by this
   * row this frame.
   */
  function cornerSpot(row, rect, clip, el, right, lift, ink, taken, fit) {
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = right - width;
    const boxes = ink.get(row) || inkOf(row);
    ink.set(row, boxes);
    const mine = taken.get(row) || [];
    const free = (l, t, w, h, obstacles) => (
      !obstacles.some((box) => overlaps(box, l, t, w, h)) && openList(row, l, t, w, h)
    );
    const spot = (l, t, w, h) => {
      mine.push({ left: l, top: t, right: l + w, bottom: t + h });
      taken.set(row, mine);
      return { left: l, top: t };
    };

    const clear = boxes.concat(mine);
    const top = Math.min(rect.bottom, clip.bottom) - height - lift;
    if (free(left, top, width, height, clear)) return spot(left, top, width, height);
    const below = boxes.reduce((lowest, box) => Math.max(lowest, box.bottom), rect.top) + 2;
    if (below + height <= clip.bottom && free(left, below, width, height, clear)) {
      return spot(left, below, width, height);
    }

    if (fit === 'shrink') {
      const beside = clear.filter((box) => box.bottom > top + 1 && box.top < top + height - 1);
      const room = right - beside.reduce((edge, box) => Math.max(edge, box.right), rect.left) - GAP;
      if (room >= 80) {
        const wide = el.style.maxWidth;
        el.style.maxWidth = `${Math.floor(room)}px`;
        const w = el.offsetWidth;
        if (free(right - w, top, w, height, clear)) return spot(right - w, top, w, height);
        el.style.maxWidth = wide;
      }
    }

    // Nowhere clear: over the words, then, but still on the list rather than
    // hanging over the composer.
    for (let t = Math.min(below, top); t >= Math.max(rect.top, clip.top); t -= 2) {
      if (openList(row, left, t, width, height)) return spot(left, t, width, height);
    }
    return spot(left, top, width, height);
  }

  /* ------------------------------------------------------------ row button */

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

    const menu = document.createElement('div');
    menu.className = 'sq-menu';
    menu.setAttribute('role', 'menu');
    const channel = currentChannel();
    const sig = rowSignature(row);

    if (!isLinked(channel)) {
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

      const past = sessionsFor(sig).slice(-2).reverse();
      for (const entry of past) {
        const again = menuButton('sq-menu-reopen', () => {
          closeMenu();
          reopen(entry.branch, sig);
          schedule();
        });
        again.title = `Open ${entry.branch} in Warp again`;
        spans(again, [['sq-glyph', '↩'], ['', `Back to ${entry.label || 'session'}`], ['sq-sub', shortBranch(entry.branch)]]);
        menu.append(again);
      }
      if (past.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'sq-menu-sep';
        menu.append(sep);
      }

      // The Linear prompt is only worth offering on a message that links an
      // issue, and then once per issue, named for it.
      const tickets = linearTickets(row);
      const entries = [];
      for (const prompt of CONFIG.prompts) {
        if (prompt.key !== LINEAR_KEY) entries.push({ prompt, ticket: null });
        else for (const ticket of tickets) entries.push({ prompt, ticket });
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
        const label = ticket ? `${prompt.label} ${ticket.id}` : prompt.label;
        entry.textContent = label;
        entry.dataset.glyph = glyphFor(prompt.emoji);
        if (index < 9) entry.dataset.key = String(index + 1);
        const letter = letterFor(prompt.label);
        if (letter) entry.dataset.letter = letter;
        entry.title = `${ticket ? `Work ${ticket.id}` : prompt.label}${repos.length > 1 ? ' in the picked repo' : ''} with ${CONFIG.agentLabel} — press ${index + 1}${letter ? ` or ${letter.toUpperCase()}` : ''}`;
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
    if (!menuEl) return;
    menuEl.querySelectorAll('.sq-repo').forEach((chip) => {
      const on = chip.dataset.repo === repo;
      if (on) chip.dataset.on = '1';
      else delete chip.dataset.on;
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
    });
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
    const repos = reposFor(currentChannel());
    const where = repos.length > 1 ? ` in ${pickedRepo(currentChannel())}` : '';
    if (where) title.textContent += where;
    submit.title = `Start ${prompt.label}${where} with ${CONFIG.agentLabel} — Enter`;
    foot.append(hint, submit);

    menu.replaceChildren(title, box, foot);

    function send() {
      const target = menuRow;
      const question = box.value.trim();
      closeMenu();
      if (target && target.isConnected) startSession(target, prompt, null, question);
      schedule();
    }

    // Like the path box, reached from the window-level claim in the triggers
    // section: Slack would otherwise take these keys for its composer.
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

  /* ------------------------------------------------------------ repo picks */

  const suggestionCache = new Map();

  /** Checkouts on this machine, best match for the channel first. */
  function suggestRepos(channel) {
    const key = channelKey(channel);
    const cached = suggestionCache.get(key);
    if (cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.repos);
    return ask({ op: 'suggest-repos', channel }).then((res) => {
      const repos = Array.isArray(res.repos) ? res.repos : [];
      suggestionCache.set(key, { at: Date.now(), repos });
      return repos;
    }).catch(() => []);
  }

  function loadMenuSuggestions(menu, before, channel) {
    suggestRepos(channel).then((repos) => {
      if (menuEl !== menu || repos.length === 0) return;
      for (const repo of repos.slice(0, MENU_SUGGESTIONS)) {
        const pick = menuButton('sq-menu-suggest', () => {
          const target = menuRow;
          closeMenu();
          linkRepo(channel, repo.path, target);
          schedule();
        });
        pick.title = `Link #${channel} to ${repo.display || repo.path}`;
        // The name is the whole label; the menu is too narrow for a path, and
        // the tooltip has it.
        spans(pick, [['sq-glyph', repo.score > 0 ? '★' : '+'], ['', `Link ${repo.name}`]]);
        menu.insertBefore(pick, before);
      }
      schedule();
    });
  }

  /**
   * Link, then carry straight on: the menu reopens on the message it came
   * from with the prompts in it, so linking is a step on the way to a
   * session rather than a detour away from one. A channel that already has a
   * repo gains another; the one just added is picked, since it is plainly the
   * one wanted next.
   */
  function linkRepo(channel, repoPath, row, onError) {
    return ask({ op: 'link-repo', channel, repoPath }).then((res) => {
      if (res.error) {
        const text = res.hint ? `${res.error} — ${res.hint}` : res.error;
        if (onError) onError(text);
        else toast({ title: 'Could not link that repo', sub: text, kind: 'error' });
        return false;
      }
      // The daemon broadcasts the new config too; this just saves waiting for it.
      storeRepos(channel, res.repos || [res.repo || '']);
      if (res.repo) repoPicks.set(channelKey(channel), res.repo);
      const count = reposFor(channel).length;
      toast({
        title: `#${channel} → ${res.repo}`,
        sub: count > 1
          ? `Added. #${channel} has ${count} repos; the menu asks which.`
          : row ? 'Linked. Now pick what to do with this message.' : 'Linked. Hover any message to start a sidequest.',
        burst: true,
      });
      if (row && row.isConnected && currentChannel() === channel) openMenu(row);
      return true;
    }).catch((err) => {
      if (onError) onError(err.message);
      else toast({ title: 'Could not link that repo', sub: err.message, kind: 'error' });
      return false;
    }).finally(() => schedule());
  }

  /** Take one repo off a channel, or all of them when `repo` is empty. */
  function unlinkRepo(channel, repo, onError) {
    return ask({ op: 'link-repo', channel, repoPath: '', repo }).then((res) => {
      if (res.error) {
        const text = res.hint ? `${res.error} — ${res.hint}` : res.error;
        if (onError) onError(text);
        else toast({ title: 'Could not unlink that repo', sub: text, kind: 'error' });
        return false;
      }
      storeRepos(channel, res.repos || []);
      const left = reposFor(channel);
      toast(left.length > 0
        ? { title: `Unlinked ${repo} from #${channel}`, sub: `Sessions here now start in ${left.join(', ')}.` }
        : { title: `Unlinked #${channel}` });
      return true;
    }).catch((err) => {
      if (onError) onError(err.message);
      else toast({ title: 'Could not unlink that repo', sub: err.message, kind: 'error' });
      return false;
    }).finally(() => schedule());
  }

  function storeRepos(channel, repos) {
    const key = channelKey(channel);
    const list = repos.filter(Boolean);
    const labels = Object.assign({}, CONFIG.repoLabels);
    if (list.length > 0) {
      labels[key] = list;
      if (!CONFIG.linkedChannels.includes(key)) CONFIG.linkedChannels = CONFIG.linkedChannels.concat(key);
    } else {
      delete labels[key];
      CONFIG.linkedChannels = CONFIG.linkedChannels.filter((c) => c !== key);
    }
    CONFIG.repoLabels = labels;
  }

  /* ------------------------------------------------------------- sessions */

  function startSession(row, prompt, ticket = null, question = '') {
    // Read everything now: the row can be recycled long before the daemon
    // answers, and the answer belongs to the message that was clicked.
    const sig = rowSignature(row);
    // One click, one session: a second click while the first is still being
    // cut would only make a -2 branch.
    if (results.get(sig)?.kind === 'busy') return;
    const meta = messageMeta(row);
    const channel = currentChannel();
    // Named only when there is a choice; a single repo is the channel's anyway.
    const repo = reposFor(channel).length > 1 ? pickedRepo(channel) : '';
    const payload = {
      op: 'start-session',
      promptKey: prompt.key,
      channel,
      repo,
      sender: senderFor(row),
      text: messageText(row),
      thread: threadContext(row),
      permalink: meta.permalink,
      ts: meta.ts,
      ticket: ticket ? ticket.url : '',
      question,
    };
    const label = (ticket ? `${prompt.label} ${ticket.id}` : prompt.label) + (repo ? ` in ${repo}` : '');

    setResult(sig, `Starting ${label}…`, 'busy');

    ask(payload).then((res) => {
      if (res.error) {
        setResult(sig, res.hint ? `${res.error} ${res.hint}` : res.error, 'error');
        return;
      }
      const base = `${label} → ${res.branch}`;
      setResult(sig, res.warning ? `${base} — ${res.warning}` : base, res.warning ? 'warn' : 'info', res.branch);
      if (res.stats) CONFIG.stats = res.stats;
      if (repo) CONFIG.lastRepos = Object.assign({}, CONFIG.lastRepos, { [channelKey(channel)]: repo });
      if (meta.ts) {
        // Mark the message now rather than on the broadcast that follows.
        const list = sessionsFor(meta.ts).concat({ key: prompt.key, label: prompt.label, branch: res.branch, at: new Date().toISOString() });
        CONFIG.sessions = Object.assign({}, CONFIG.sessions, { [meta.ts]: list });
      }
      celebrate(prompt, res);
      if (res.reply) {
        postReply(meta.permalink, res.reply).catch((err) => {
          toast({ title: 'Could not reply in the thread', sub: err.message, kind: 'error' });
        });
      }
    }).catch((err) => {
      setResult(sig, err.message, 'error');
    }).finally(() => {
      schedule();
    });
  }

  /**
   * Where a reply to a message goes, read off its permalink: the channel id,
   * and the thread it starts or already sits in.
   */
  function replyTarget(permalink) {
    const match = String(permalink || '').match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
    if (!match) return null;
    const inThread = String(permalink).match(/[?&]thread_ts=(\d{10}\.\d{4,6})/);
    return { channel: match[1], threadTs: inThread ? inThread[1] : `${match[2]}.${match[3]}` };
  }

  /**
   * The workspace this window is signed in to, as Slack's own client keeps it:
   * its API host and your session token. Neither leaves this window; the
   * daemon never sees them.
   */
  function slackTeam() {
    let teams;
    try {
      teams = JSON.parse(localStorage.getItem('localConfig_v2') || '{}').teams || {};
    } catch {
      teams = {};
    }
    const list = Object.entries(teams).map(([id, team]) => Object.assign({ id }, team));
    const fromUrl = location.pathname.match(/\/client\/([A-Z0-9]+)/);
    const team = (fromUrl && list.find((t) => t.id === fromUrl[1] || t.enterprise_id === fromUrl[1])) ||
      (list.length === 1 ? list[0] : null);
    return team && team.token && team.url ? team : null;
  }

  /**
   * Say in the thread that you're on it, as you. The only request the overlay
   * makes itself, sent only when settings.autoReply is on, and only to the
   * workspace's own API.
   */
  async function postReply(permalink, text) {
    const target = replyTarget(permalink);
    if (!target) throw new Error('Slack gave that message no link to reply under.');
    const team = slackTeam();
    if (!team) throw new Error('Could not find which Slack workspace this window is signed in to.');
    const form = new FormData();
    form.append('token', team.token);
    form.append('channel', target.channel);
    form.append('thread_ts', target.threadTs);
    form.append('text', text);
    const res = await fetch(new URL('api/chat.postMessage', team.url).href, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Slack said ${body.error || `HTTP ${res.status}`}.`);
    log('replied in thread', target);
  }

  /** Back into a session started earlier. */
  function reopen(branch, sig) {
    if (!branch) return;
    if (sig) setResult(sig, `Opening ${branch}…`, 'busy');
    ask({ op: 'reopen', branch }).then((res) => {
      if (res.error) {
        const text = res.hint ? `${res.error} ${res.hint}` : res.error;
        if (sig) setResult(sig, text, 'error');
        else toast({ title: 'Could not reopen that session', sub: text, kind: 'error' });
        return;
      }
      if (sig) setResult(sig, `Back in ${branch}`, 'info', branch);
    }).catch((err) => {
      if (sig) setResult(sig, err.message, 'error');
    }).finally(() => schedule());
  }

  /* ----------------------------------------------------------------- toast */

  /**
   * The moment a session lands is worth marking. Counting them — this one's
   * number, how many today, how many days running — turns a tool you reach
   * for into a habit you keep, and the milestones are there to be hit.
   */
  function celebrate(prompt, res) {
    const s = res.stats;
    const where = res.warning
      ? 'Worktree ready — Warp did not open'
      : `${CONFIG.agentLabel} is starting in Warp`;
    if (!s) {
      toast({ title: `${prompt.label} is underway`, sub: where, burst: true });
      return;
    }
    let title;
    if (s.total === 1) title = 'Your first sidequest is underway';
    else if (s.milestone) title = `Sidequest #${s.total} — milestone!`;
    else if (s.firstToday && s.streak >= 2) title = `${s.streak}-day streak — sidequest #${s.total}`;
    else title = `Sidequest #${s.total} is underway`;

    const bits = [where];
    if (s.today > 1) bits.push(`${s.today} today`);
    if (s.streak >= 2 && !(s.firstToday && title.includes('streak'))) bits.push(`🔥 ${s.streak}-day streak`);
    toast({ title, sub: bits.join(' · '), burst: true, big: Boolean(s.milestone) || s.total === 1 });
  }

  function toast({ title, sub = '', kind = 'info', burst = false, big = false }) {
    if (!ensureLayer()) return;
    clearTimeout(toastTimer);
    toastEl?.remove();

    const el = document.createElement('div');
    el.className = 'sq-toast';
    el.dataset.kind = kind;
    el.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'sq-toast-icon';
    icon.innerHTML = iconSvg();
    if (burst) {
      const colors = ['#a78bfa', '#7c3aed', '#f472b6', '#facc15', '#34d399'];
      const count = big ? 16 : 10;
      for (let i = 0; i < count; i += 1) {
        const spark = document.createElement('span');
        spark.className = 'sq-spark';
        spark.style.setProperty('--a', `${Math.round((360 / count) * i)}deg`);
        spark.style.setProperty('--c', colors[i % colors.length]);
        spark.style.animationDelay = `${(i % 3) * 40}ms`;
        icon.append(spark);
      }
    }

    const body = document.createElement('div');
    body.className = 'sq-toast-body';
    const head = document.createElement('div');
    head.className = 'sq-toast-title';
    head.textContent = title;
    body.append(head);
    if (sub) {
      const line = document.createElement('div');
      line.className = 'sq-toast-sub';
      line.textContent = sub;
      line.title = sub;
      body.append(line);
    }
    el.append(icon, body);

    const dismiss = () => {
      if (toastEl !== el) return;
      el.dataset.leaving = '1';
      setTimeout(() => {
        el.remove();
        if (toastEl === el) toastEl = null;
      }, 250);
    };
    el.addEventListener('click', (event) => {
      stop(event);
      dismiss();
    });
    // Reading it is a reason to keep it up.
    el.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    el.addEventListener('mouseleave', () => { toastTimer = setTimeout(dismiss, 1800); });

    toastEl = el;
    ui.append(el);
    toastTimer = setTimeout(dismiss, kind === 'error' ? TOAST_MS * 2 : TOAST_MS);
    schedule();
  }

  /** Top centre of the message list: where the eye already is. */
  function placeToast(clip) {
    if (!toastEl) return;
    const area = clip || { top: 0, left: 0, right: window.innerWidth };
    const header = document.querySelector(SEL.header);
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
    const top = Math.max(area.top, headerBottom) + 12;
    const left = area.left + ((area.right - area.left) - toastEl.offsetWidth) / 2;
    placeAt(toastEl, left, top);
  }

  /* ---------------------------------------------------------------- results */

  /** Keyed by message, not by row, so scrolling away and back keeps the line. */
  const results = new Map();

  function setResult(sig, text, kind, branch = '') {
    if (!sig) return;
    results.delete(sig);
    results.set(sig, { text, kind, branch, at: Date.now() });
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
    schedule();
  }

  function pruneResults() {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [sig, entry] of results) {
      if (entry.at < cutoff) results.delete(sig);
    }
  }

  /**
   * Clicking the line takes you back to the session it names; the × is how
   * it goes away. A line with no session behind it — an error, or one still
   * starting — just goes away.
   */
  function buildResult(sig) {
    const el = document.createElement('div');
    el.className = 'sq-result';
    const text = document.createElement('span');
    text.className = 'sq-result-text';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sq-result-x';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', (event) => {
      stop(event);
      results.delete(sig);
      schedule();
    });
    el.append(text, close);
    el.addEventListener('click', (event) => {
      stop(event);
      const entry = results.get(sig);
      if (!entry || entry.kind === 'busy') return;
      if (entry.branch) reopen(entry.branch, sig);
      else results.delete(sig);
      schedule();
    });
    return el;
  }

  function buildMark(sig) {
    const el = document.createElement('div');
    el.className = 'sq-mark';
    el.addEventListener('click', (event) => {
      stop(event);
      const list = sessionsFor(sig);
      const last = list[list.length - 1];
      if (last) reopen(last.branch, sig);
    });
    return el;
  }

  function markText(list) {
    const last = list[list.length - 1];
    const label = last.label || 'Session';
    return list.length > 1 ? `${label} +${list.length - 1}` : label;
  }

  /* -------------------------------------------------------- channel button */

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
    button.append(dot, icon, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
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
   * The panel's path box or the menu's Ask box, while it holds the keyboard.
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

    const channel = currentChannel();
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

    input.placeholder = current.length > 0
      ? 'Add a repo: search, or paste a path'
      : 'Search your repos, or paste a path';
    if (current.length === 0) hide(linked);
    panel.append(title, linked, input, list, note, error, actions);

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
    // Reached from the window-level claim in the triggers section rather than
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

    const title = linked
      ? repos.length > 1
        ? `#${channel} starts ${CONFIG.agentLabel} sessions in ${repos.join(', ')} — click to add or unlink`
        : `#${channel} starts ${CONFIG.agentLabel} sessions in ${repo} — click to add another or unlink`
      : `Link #${channel} to a git repo so messages can start ${CONFIG.agentLabel} sessions`;
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
    // Read once per frame per row: the pill, the line and the mark can all
    // want the same row's text.
    const ink = new Map();
    const taken = new Map();

    if (activeRect && clip && onScreen(activeRect, clip)) {
      const flag = isLinked(currentChannel()) ? '1' : '0';
      if (launchBtn.dataset.linked !== flag) launchBtn.dataset.linked = flag;
      const total = CONFIG.stats?.total || 0;
      const streak = CONFIG.stats?.streak || 0;
      const tally = total > 0
        ? ` · ${total} so far${streak >= 2 ? `, ${streak}-day streak` : ''}`
        : '';
      const tip = `Start a ${CONFIG.agentLabel} session from this message${tally}`;
      if (launchBtn.title !== tip) launchBtn.title = tip;
      show(launchBtn);
      // Slack's own hover actions and an unread divider's "New" label both live
      // at a row's top-right corner, so the pill takes the bottom-right and
      // leaves them clickable.
      const at = cornerSpot(activeRow, activeRect, clip, launchBtn, activeRect.right - GAP, 3, ink, taken, null);
      placeAt(launchBtn, at.left, at.top);
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
      const text = el.firstChild;
      if (text.textContent !== entry.text) {
        text.textContent = entry.text;
        // The line is one line wide; the tooltip is where all of it lives.
        el.title = entry.branch
          ? `${entry.text}\n\nClick to open ${entry.branch} in Warp again.`
          : entry.text;
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
        const at = cornerSpot(row, rect, clip, el, right, 3, ink, taken, 'shrink');
        placeAt(el, at.left, at.top);
      } else {
        hide(el);
      }
    }

    // Messages that already have a session, and no live line of their own.
    for (const [sig, el] of markEls) {
      if (results.has(sig) || !bySig.has(sig) || sessionsFor(sig).length === 0) {
        el.remove();
        markEls.delete(sig);
      }
    }
    for (const [sig, row] of bySig) {
      if (results.has(sig)) continue;
      const list = sessionsFor(sig);
      if (list.length === 0) continue;
      let el = markEls.get(sig);
      if (!el) {
        el = buildMark(sig);
        markEls.set(sig, el);
        ui.append(el);
      }
      const text = markText(list);
      if (el.textContent !== text) {
        el.textContent = text;
        const last = list[list.length - 1];
        el.title = `Sidequested → ${last.branch}` +
          (list.length > 1 ? ` (and ${list.length - 1} more)` : '') +
          '\nClick to open it in Warp again.';
      }
      const rect = row.getBoundingClientRect();
      if (clip && onScreen(rect, clip)) {
        show(el);
        const reserve = row === activeRow && !launchBtn.classList.contains('sq-off')
          ? launchBtn.offsetWidth + GAP
          : 0;
        const at = cornerSpot(row, rect, clip, el, rect.right - GAP - reserve, 4, ink, taken, 'shrink');
        placeAt(el, at.left, at.top);
      } else {
        hide(el);
      }
    }

    placeToast(clip);
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
      if (!typingBox()) return;
      if (event.type === 'paste') pasteTicket = 0;
      event.stopImmediatePropagation();
    }, true);
  }

  window.addEventListener('keydown', (event) => {
    if (menuKeys(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      schedule();
      return;
    }
    const input = typingBox();
    if (!input) return;
    // The same stop keeps a keystroke meant for the box from also being a
    // Slack shortcut, and keeps anything downstream from cancelling the key's
    // own paste.
    event.stopImmediatePropagation();
    boxKeys?.(event);
    if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'v') return;

    // A paste normally follows as that key's default action, and the handler
    // above clears the ticket when it does. Where the app takes the shortcut
    // for itself and no paste ever arrives, read the clipboard directly.
    const ticket = ++pasteTicket;
    setTimeout(() => {
      if (pasteTicket !== ticket || typingBox() !== input) return;
      Promise.resolve(navigator.clipboard?.readText?.()).then((text) => {
        if (text && pasteTicket === ticket && typingBox() === input) insertText(input, text);
      }).catch(() => {});
    }, 0);
  }, true);

  for (const type of ['keypress', 'keyup']) {
    window.addEventListener(type, (event) => {
      if (typingBox()) event.stopImmediatePropagation();
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
