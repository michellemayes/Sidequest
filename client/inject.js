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
 * And three that follow from them: a chip under a message's text while its
 * session starts, which becomes a quiet mark once it has (click it to be back
 * in that session), and a toast when a session lands. Then the sessions
 * panel (⌃⇧S, or from the channel button's panel): your recent sessions that
 * still have a worktree, to reopen or to remove once they are done.
 *
 * Everything but that chip is drawn in a layer of sidequest's own: one
 * zero-sized, pointer-events: none host at the end of <body>, with a shadow
 * root holding every element and its stylesheet. Slack's lists are virtualised
 * and their rows are measured and recycled, so the rest of Slack's DOM is never
 * written to — no attributes, no styles, and no rule in here can match a Slack
 * element. The chip is the one exception, and it is a single element of its own
 * after a message's content, holding its own shadow root (see inline): it grows
 * the message the way a reaction does, which is the point of it, and touches
 * nothing else. `[data-qa="virtual-list-item"]` is also not just messages:
 * the sidebar, the DM list and search results are virtual lists too, so
 * anything drawn from that selector alone lands all over the app. Rows are
 * matched on a message's own content.
 *
 * Everything anchored to a message is keyed by the message it belongs to, so a
 * recycled row drops what was drawn for its previous occupant instead of
 * relabelling it; the pill is positioned from the row's rectangle each frame.
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
    agentHost: 'Warp',
    agentInApp: false,
    headless: false,
    sessions: {},
    stats: { total: 0, today: 0, streak: 0 },
    postResults: 'ask',
    /* Where Slack serves the files attached to messages from. */
    fileHosts: '(^|\\.)files\\.slack\\.com$|(^|\\.)slack-files\\.com$',
    verbose: false,
  }, window.__SIDEQUEST_CONFIG || {});

  /* What clicking a past session does, for tooltips: headless has no window to reopen. */
  const reopenHint = (what) => CONFIG.headless
    ? `see ${what === 'it' ? 'its' : `${what}'s`} result`
    : `open ${what} in ${CONFIG.agentHost} again`;

  const ASK = '__sidequestAsk';
  const LAYER_ID = 'sidequest-layer';
  const REQUEST_TIMEOUT_MS = 120000;
  // A result outlives a scroll away and back, not a working session.
  const RESULT_TTL_MS = 10 * 60 * 1000;
  const MAX_RESULTS = 20;
  const ASK_KEY = 'ask';
  const TICK_MS = 250;
  /* What a message may bring into a session. src/session/attachments.ts holds the daemon to the same. */
  const MAX_FILES = 6;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_FILES_TOTAL = 20 * 1024 * 1024;
  const FILE_TIMEOUT_MS = 10000;
  const TOAST_MS = 5200;
  /* Suggestions shown in the message menu for a channel with no repo. */
  const MENU_SUGGESTIONS = 3;
  const PANEL_SUGGESTIONS = 6;
  // What the overlay leaves between itself and anything of Slack's.
  const GAP = 8;
  /*
   * The sessions panel's shortcut: Control-Shift-S. Slack on the Mac binds its
   * own shortcuts to Command, and macOS's text-editing keys are Control with
   * no Shift, so this chord is free on both counts.
   */
  const isSessionsKey = (event) => event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey
    && event.code === 'KeyS';
  const SESSIONS_KEY_LABEL = '⌃⇧S';

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
  const TOKENS = `
    :host {
      --sq-line: color-mix(in srgb, currentColor 16%, transparent);
      --sq-line-hover: color-mix(in srgb, currentColor 34%, transparent);
      --sq-wash: color-mix(in srgb, currentColor 8%, transparent);
      --sq-shade: color-mix(in srgb, currentColor 20%, transparent);
      --sq-ok: #2eb67d;
      --sq-bad: #e01e5a;
    }
  `;

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
    ${TOKENS}

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
    /* Replies waiting to be read, on the pill that is always in the header,
       so one that scrolled away or outlived its toast is a click away. */
    .sq-reply-count {
      flex: 0 0 auto; padding: 0 6px; margin-right: -4px;
      font-size: 11px; line-height: 16px; font-weight: 600;
      color: #fff; background: #8b5cf6; border-radius: 8px;
    }
    .sq-reply-count:hover { background: #7c3aed; }
    .sq-pill[data-compact="1"] > .sq-reply-count { display: none; }

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
    .sq-menu-reopen, .sq-menu-suggest, .sq-menu-reply { font-size: 12px !important; }
    .sq-menu-reopen > span, .sq-menu-suggest > span, .sq-menu-reply > span {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sq-menu-reopen > .sq-glyph, .sq-menu-suggest > .sq-glyph, .sq-menu-reply > .sq-glyph { flex: 0 0 18px; text-align: center; }
    .sq-menu-reply { font-weight: 600; }
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
    /* A reply to read before it goes out: wider than the path panel, and
       with room for a few paragraphs. */
    .sq-panel.sq-reply { width: min(520px, calc(100vw - 32px)); }
    .sq-reply .sq-reply-input { min-height: 140px; max-height: 50vh; font-size: 13px; line-height: 18px; }
    .sq-reply .sq-note[data-kind="error"] { color: var(--sq-bad); opacity: 1; }
    .sq-reply-skip, .sq-reply .sq-ask-send {
      padding: 4px 12px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px; font-weight: 500;
      color: inherit; background: transparent;
      border: 1px solid var(--sq-line-hover); border-radius: 5px; cursor: pointer;
    }
    .sq-reply-skip { margin-left: auto; }
    .sq-reply-skip:hover { background: var(--sq-wash); }
    .sq-reply .sq-ask-send { color: #fff; background: #007a5a; border-color: #007a5a; }
    .sq-reply .sq-ask-send:hover { background: #148567; }
    /* A sentence, not a menu item. It wraps inside the menu rather than
       stretching it into a bar across the message underneath. */
    .sq-note {
      padding: 6px 8px 4px; font-size: 12px; line-height: 16px; opacity: .7;
      white-space: normal; overflow-wrap: break-word;
    }

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
    .sq-toast-action {
      flex: 0 0 auto; margin-left: 4px; padding: 4px 10px;
      font-family: inherit; font-size: 12px; line-height: 16px; font-weight: 600;
      color: #fff; background: #7c3aed; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-toast-action:hover { background: #6d28d9; }
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
    /* A panel's title with a quiet way elsewhere beside it: from a channel's
       repos to every session, and back. */
    .sq-panel-head { display: flex; align-items: baseline; gap: 8px; }
    .sq-panel-head .sq-panel-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-panel-aside {
      flex: 0 0 auto; margin: 0 0 0 auto; padding: 0 6px;
      font-family: inherit; font-size: 11px; line-height: 18px;
      color: inherit; opacity: .6;
      background: transparent; border: 0; border-radius: 4px; cursor: pointer;
    }
    .sq-panel-aside:hover { opacity: 1; background: var(--sq-wash); }

    /* The sessions panel: the panel's frame, a list in it. */
    .sq-sessions { width: 360px; }
    .sq-sessions-list {
      display: flex; flex-direction: column; gap: 1px;
      max-height: min(360px, 60vh); overflow-y: auto; margin: 0 -4px;
    }
    .sq-session { display: flex; align-items: flex-start; gap: 2px; border-radius: 5px; }
    .sq-session:hover, .sq-session[data-active="1"] { background: var(--sq-wash); }
    .sq-session[data-busy="1"] { opacity: .5; pointer-events: none; }
    .sq-session-open {
      display: flex; flex-direction: column; gap: 1px;
      flex: 1 1 auto; min-width: 0; padding: 5px 4px 5px 8px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px;
      color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-session-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .sq-session-branch { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-session-meta { font-size: 11px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sq-session-state { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
    .sq-session-state:empty { display: none; }
    .sq-chip {
      padding: 0 6px; font-size: 10px; line-height: 15px;
      border: 1px solid var(--sq-line); border-radius: 8px; opacity: .8;
    }
    .sq-chip[data-tone="ok"] { color: var(--sq-ok); border-color: color-mix(in srgb, var(--sq-ok) 45%, transparent); opacity: 1; }
    .sq-chip[data-tone="warn"] { color: #e8912d; border-color: color-mix(in srgb, #e8912d 45%, transparent); opacity: 1; }
    .sq-chip[data-tone="bad"] { color: var(--sq-bad); border-color: color-mix(in srgb, var(--sq-bad) 45%, transparent); opacity: 1; }
    .sq-session-x {
      flex: 0 0 auto; margin: 4px 4px 0 0; padding: 0 6px;
      font: inherit; font-size: 13px; line-height: 20px; color: inherit; opacity: .4;
      background: transparent; border: 0; border-radius: 3px; cursor: pointer;
    }
    .sq-session-x:hover { opacity: 1; background: var(--sq-wash); }
    .sq-chip[data-tone="reply"] { color: #8b5cf6; border-color: color-mix(in srgb, #8b5cf6 45%, transparent); opacity: 1; }
    /* Replies an agent left that have not been posted or dropped: first in
       the panel, since they are the thing waiting on you. */
    .sq-replies { display: flex; flex-direction: column; gap: 1px; margin: 0 -4px 6px; padding-bottom: 6px; border-bottom: 1px solid var(--sq-line); }
    .sq-replies-head { padding: 0 8px 2px; font-size: 11px; font-weight: 600; opacity: .65; }
    .sq-reply-row {
      display: flex; align-items: baseline; gap: 6px; padding: 5px 8px; margin: 0;
      font-family: inherit; font-size: 12px; line-height: 16px; color: inherit; text-align: left;
      background: transparent; border: 0; border-radius: 5px; cursor: pointer;
    }
    .sq-reply-row:hover { background: var(--sq-wash); }
    .sq-reply-row > .sq-session-branch { flex: 1 1 auto; }
    /* Asking before removing, in the row itself, so what is being removed
       stays in view while the question is asked. */
    .sq-session-confirm {
      display: flex; flex-direction: column; gap: 6px;
      flex: 1 1 auto; min-width: 0; padding: 6px 8px;
      font-size: 12px; line-height: 16px;
    }
    .sq-session[data-confirm="force"] { box-shadow: inset 2px 0 0 var(--sq-bad); }
    .sq-session-confirm .sq-panel-actions { margin: 0; }
    .sq-panel-actions button[data-danger="1"] { color: #fff; background: var(--sq-bad); border-color: var(--sq-bad); }
    .sq-panel-actions button[data-danger="1"]:hover { background: color-mix(in srgb, var(--sq-bad) 85%, #000); }
  `;

  /*
   * For the chip that sits inside a message, under its text (see inline).
   * It is in the message's own flow, so it inherits the message's font and
   * colour and needs no background: it scrolls with the words and moves for
   * nothing.
   */
  const INLINE_CSS = `
    ${TOKENS}
    :host { display: block; margin: 4px 0 2px; }
    .sq-off { display: none !important; }

    /* While a session starts, or when it could not: one chip, wrapped to as
       many lines as an error needs, with an × to clear it. */
    .sq-result {
      box-sizing: border-box;
      display: inline-flex; align-items: flex-start; gap: 6px;
      max-width: 100%; padding: 1px 4px 1px 8px;
      font-family: inherit; font-size: 12px; line-height: 16px;
      color: inherit;
      border: 1px solid var(--sq-line); border-radius: 6px;
      cursor: pointer;
    }
    .sq-result:hover { border-color: var(--sq-line-hover); background: var(--sq-wash); }
    .sq-result[data-kind="error"] { border-color: color-mix(in srgb, var(--sq-bad) 55%, transparent); }
    .sq-result-text { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
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
    @keyframes sq-shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }

    /* A message that already has a session: a quiet chip, like a reaction,
       one click from being back in it. */
    .sq-mark {
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 4px;
      max-width: 100%; height: 20px; padding: 0 8px;
      font-family: inherit; font-size: 12px; line-height: 18px;
      color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      border: 1px solid var(--sq-line); border-radius: 10px;
      cursor: pointer;
    }
    .sq-mark:hover { border-color: var(--sq-line-hover); background: var(--sq-wash); }
    .sq-mark::before { content: '✦'; color: #8b5cf6; }
    /* Progress shows in the words; the few states worth a glance get colour too. */
    .sq-mark[data-state="merged"]::before { color: var(--sq-ok); }
    .sq-mark[data-state="pr-closed"], .sq-mark[data-state="gone"] { opacity: .6; }
    .sq-mark[data-reply="1"] { border-color: #8b5cf6; }
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
  let sessionsEl = null;
  /** Keys for whichever text box holds the keyboard: the path box or the Ask box. */
  let boxKeys = null;
  let toastEl = null;
  let toastTimer = 0;

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
    sessionsEl = null;
    boxKeys = null;
    toastEl = null;
    themeSig = '';
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

  // Settings changed elsewhere — another window, the menu bar, the terminal —
  // or a session moved on: it committed, opened a pull request, left a reply.
  window.__sidequestSetConfig = (json) => {
    try {
      Object.assign(CONFIG, JSON.parse(json));
    } catch {
      return;
    }
    announceReplies();
    // A broadcast follows every new session, so an open list catches up.
    if (sessionsEl) loadSessions();
    schedule();
  };

  /*
   * With postResults on auto the daemon picks one window to post a reply
   * from, and this is how it asks. True means this window took it on; the
   * outcome goes back up as result-posted either way.
   */
  window.__sidequestPostResult = (json) => {
    let job;
    try {
      job = JSON.parse(json);
    } catch {
      return false;
    }
    if (!job || !job.permalink || !slackTeam(job.permalink)) return false;
    postReply(job.permalink, job.text).then(() => {
      toast({ title: `Replied in the thread for ${job.label || 'a session'}`, sub: job.branch });
      return ask({ op: 'result-posted', branch: job.branch, resultMs: job.resultMs });
    }).catch((err) => {
      toast({ title: 'Could not post the reply', sub: err.message, kind: 'error' });
      return ask({ op: 'result-posted', branch: job.branch, resultMs: job.resultMs, error: err.message });
    }).catch(() => {});
    return true;
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

  /** The id of the channel a message sits in, off its permalink. */
  function rowChannelId(row) {
    const match = messageMeta(row).permalink.match(/\/archives\/([A-Z0-9]+)\//);
    return match ? match[1] : '';
  }

  /**
   * The id of the channel open in the main view, off Slack's URL
   * (/client/T…/C…). Empty when Slack is showing something that is not a
   * channel — Threads, Activity, search — and null when the URL is not
   * Slack's at all, which leaves the header as the only word on it.
   */
  function viewChannelId() {
    const path = location.pathname;
    if (!/\/client\/[A-Z0-9]+/.test(path)) return null;
    const match = path.match(/\/client\/[A-Z0-9]+\/([CG][A-Z0-9]+)(?:[/?#]|$)/);
    return match ? match[1] : '';
  }

  /** Channel names by id, from wherever one was seen or asked for. */
  const channelNames = new Map();
  const channelLookups = new Map();

  /** A channel's name from its sidebar row, when the sidebar has one rendered. */
  function sidebarName(id) {
    const item = document.querySelector(`[data-qa-channel-sidebar-channel-id="${id}"]`);
    if (!item) return '';
    const name = item.querySelector('[data-qa^="channel_sidebar_name_"], .p-channel_sidebar__name');
    return (name || item).textContent.trim().replace(/^#+/, '');
  }

  /**
   * The channel a message belongs to. On a channel's own page that is the
   * header, but the Threads view and search mix messages from many channels
   * under one page, and the header — or whatever channel was open before —
   * says nothing about any one of them. There the message's permalink names
   * its channel, and the name is looked up by id. Empty when it cannot be
   * told yet; resolveChannel() asks Slack.
   */
  function channelFor(row) {
    const header = currentChannel();
    const id = row ? rowChannelId(row) : '';
    const view = viewChannelId();
    if (!id || view === null) return header;
    if (view === id && header) {
      channelNames.set(id, header);
      return header;
    }
    const known = channelNames.get(id) || sidebarName(id);
    if (known) channelNames.set(id, known);
    return known || '';
  }

  // A lookup that came back empty is not retried on every frame.
  const forget = (id) => setTimeout(() => channelLookups.delete(id), 30000);

  /** Ask Slack for the name of a channel the page does not show. Once per id. */
  function resolveChannel(row) {
    const id = row ? rowChannelId(row) : '';
    if (!id || channelNames.has(id)) return Promise.resolve(channelNames.get(id) || '');
    if (channelLookups.has(id)) return channelLookups.get(id);
    const team = slackTeam();
    if (!team) return Promise.resolve('');
    const form = new FormData();
    form.append('token', team.token);
    form.append('channel', id);
    const lookup = fetch(new URL('api/conversations.info', team.url).href, {
      method: 'POST',
      body: form,
      credentials: 'include',
    })
      .then((res) => res.json())
      .then((body) => {
        const name = body && body.ok && body.channel && body.channel.name ? String(body.channel.name) : '';
        if (name) channelNames.set(id, name);
        else forget(id);
        return name;
      })
      .catch(() => {
        forget(id);
        return '';
      });
    channelLookups.set(id, lookup);
    return lookup;
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
   * The prompts that work a tracker's ticket, keyed by prompt key, each shown
   * only on a message that links one. The patterns mirror
   * src/config/tickets.ts, which reads the link again on the way in; `id`
   * tells two links to the same ticket apart and `name` follows the prompt's
   * label in the menu (Linear DATA-3051, GitHub #123, Jira ABC-123).
   */
  const TICKET_PROMPTS = {
    linear: {
      pattern: /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)[^\s<>|]*/gi,
      id: (m) => m[1].toUpperCase(),
      name: (m) => m[1].toUpperCase(),
    },
    github: {
      pattern: /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/issues\/(\d+)(?!\d)/gi,
      id: (m) => `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(),
      name: (m) => `#${m[3]}`,
    },
    jira: {
      pattern: /https?:\/\/[^/\s<>|]+(?:\/[^/\s<>|?#]+)*?\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?![\w-])/gi,
      id: (m) => m[1].toUpperCase(),
      name: (m) => m[1].toUpperCase(),
    },
  };
  // More than this and the menu is mostly tickets; the first ones are the point.
  const MAX_TICKETS = 2;

  /**
   * The tickets a message links, of any tracker, first seen first. Read off
   * the links' own hrefs as well as the text, since a link can be labelled
   * with anything.
   */
  function messageTickets(item) {
    const content = item.querySelector(SEL.content);
    if (!content) return [];
    const sources = Array.from(content.querySelectorAll('a[href]'), (a) => a.href);
    sources.push(messageText(item));
    const found = new Map();
    for (const source of sources) {
      const inSource = [];
      for (const [key, tracker] of Object.entries(TICKET_PROMPTS)) {
        for (const match of String(source).matchAll(tracker.pattern)) {
          inSource.push({ index: match.index, key, id: tracker.id(match), name: tracker.name(match), url: match[0] });
        }
      }
      inSource.sort((a, b) => a.index - b.index);
      for (const { key, id, name, url } of inSource) {
        if (!found.has(`${key}:${id}`)) found.set(`${key}:${id}`, { key, id, name, url });
      }
    }
    return Array.from(found.values()).slice(0, MAX_TICKETS);
  }

  /**
   * The files attached to a message: screenshots, logs, anything Slack
   * serves from its file host. An image shows as a thumbnail wrapped in a
   * link to the original, so each file is keyed by its Slack file id and the
   * original wins over the thumbnail. Avatars and emoji come from other
   * hosts and never match.
   */
  function messageFiles(item) {
    let hosts;
    try {
      hosts = new RegExp(CONFIG.fileHosts, 'i');
    } catch {
      return [];
    }
    const found = new Map();
    item.querySelectorAll('a[href], img[src]').forEach((node) => {
      const raw = node.tagName === 'IMG' ? (node.currentSrc || node.src) : node.href;
      let url;
      try {
        url = new URL(raw, location.href);
      } catch {
        return;
      }
      if (!hosts.test(url.hostname)) return;
      const id = (url.pathname.match(/\b(F[A-Z0-9]{6,})\b/) || [])[1] || url.pathname;
      const rank = /files-tmb|_(?:64|80|160|360|480|720|800|960|1024)\./.test(url.pathname) ? 1 : 0;
      const known = found.get(id);
      if (known && known.rank <= rank) return;
      const segment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
      const name = node.getAttribute('data-file-name') || node.getAttribute('aria-label') || segment;
      found.set(id, { url: url.href, rank, name: /\.[a-z0-9]{1,5}$/i.test(name) ? name : segment || name });
    });
    return Array.from(found.values()).slice(0, MAX_FILES);
  }

  /**
   * Fetch the files with this window's own Slack session, since the daemon
   * has none, and hand them down as base64. A file that will not come, or
   * comes back as a sign-in page, is left out rather than failing the session.
   */
  async function fetchFiles(files) {
    const out = [];
    let total = 0;
    for (const file of files) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);
      try {
        const res = await fetch(file.url, { credentials: 'include', signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (/text\/html/i.test(blob.type)) throw new Error('got a page, not the file');
        if (blob.size === 0 || blob.size > MAX_FILE_BYTES || total + blob.size > MAX_FILES_TOTAL) {
          throw new Error(`${blob.size} bytes is over the limit`);
        }
        total += blob.size;
        out.push({ name: file.name, type: blob.type, data: await base64Of(blob) });
      } catch (err) {
        log('could not fetch', file.url, err.message);
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }

  function base64Of(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error || new Error('could not read the file'));
      reader.readAsDataURL(blob);
    });
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
    // The chip under the words is the overlay's own, but it is in the
    // message now and the pill keeps off it like anything else there.
    const chip = row.querySelector(INLINE_TAG)?.shadowRoot?.querySelector('.sq-result:not(.sq-off), .sq-mark:not(.sq-off)');
    if (chip) {
      const box = chip.getBoundingClientRect();
      if (box.width > 1 && box.height > 1) boxes.push(box);
    }
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
        entry.title = `${ticket ? `Work ${prompt.label} ${ticket.name}` : prompt.label}${repos.length > 1 ? ' in the picked repo' : ''} with ${CONFIG.agentLabel} — press ${index + 1}${letter ? ` or ${letter.toUpperCase()}` : ''}`;
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
    const channel = channelFor(menuRow);
    const repos = reposFor(channel);
    const where = repos.length > 1 ? ` in ${pickedRepo(channel)}` : '';
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
      if (row && row.isConnected && channelFor(row) === channel) openMenu(row);
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
    const files = messageFiles(row);
    const channel = channelFor(row);
    if (!channel) {
      setResult(sig, 'Could not tell which channel this message is in.', 'error');
      return;
    }
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
    const label = (ticket ? `${prompt.label} ${ticket.name}` : prompt.label) + (repo ? ` in ${repo}` : '');

    setResult(sig, files.length > 0
      ? `Starting ${label} with ${files.length} file${files.length === 1 ? '' : 's'}…`
      : `Starting ${label}…`, 'busy');

    fetchFiles(files).then((attachments) => {
      payload.attachments = attachments;
      return ask(payload);
    }).then((res) => {
      if (res.error) {
        setResult(sig, res.hint ? `${res.error} ${res.hint}` : res.error, 'error');
        return;
      }
      const skipped = files.length - (res.attachments || 0);
      const extra = files.length === 0 ? ''
        : skipped > 0 ? ` (${skipped} of ${files.length} files could not be fetched)`
          : ` with ${files.length} file${files.length === 1 ? '' : 's'}`;
      const base = `${label} → ${res.branch}${extra}`;
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
  function slackTeam(permalink = '') {
    let teams;
    try {
      teams = JSON.parse(localStorage.getItem('localConfig_v2') || '{}').teams || {};
    } catch {
      teams = {};
    }
    const list = Object.entries(teams).map(([id, team]) => Object.assign({ id }, team));
    // A permalink names its workspace by host, which is how a reply finds its
    // way home even when this window is showing another workspace.
    const host = hostOf(permalink);
    const byHost = host ? list.find((t) => t.token && hostOf(t.url) === host) : null;
    if (byHost) return byHost;
    const fromUrl = location.pathname.match(/\/client\/([A-Z0-9]+)/);
    const team = (fromUrl && list.find((t) => t.id === fromUrl[1] || t.enterprise_id === fromUrl[1])) ||
      (list.length === 1 ? list[0] : null);
    return team && team.token && team.url ? team : null;
  }

  function hostOf(url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Say in the thread that you're on it, as you. The only request the overlay
   * makes itself, sent only when settings.autoReply is on, and only to the
   * workspace's own API.
   */
  async function postReply(permalink, text) {
    const target = replyTarget(permalink);
    if (!target) throw new Error('Slack gave that message no link to reply under.');
    const team = slackTeam(permalink);
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
      ? (CONFIG.headless ? 'Worktree ready — the agent did not start' : `Worktree ready — ${CONFIG.agentHost} did not open`)
      : CONFIG.agentInApp
        ? `Prompt ready in ${CONFIG.agentHost} — press Enter there to start`
        : CONFIG.headless
          ? `${CONFIG.agentLabel} is working in the background`
          : `${CONFIG.agentLabel} is starting in ${CONFIG.agentHost}`;
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

  function toast({ title, sub = '', kind = 'info', burst = false, big = false, action = null }) {
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
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sq-toast-action';
      button.textContent = action.label;
      button.addEventListener('click', (event) => {
        stop(event);
        dismiss();
        action.run();
      });
      el.append(button);
    }

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
    toastTimer = setTimeout(dismiss, kind === 'error' || action ? TOAST_MS * 2 : TOAST_MS);
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
      if (!last) return;
      if (last.status && last.status.reply) openReplyPanel(last.branch);
      else reopen(last.branch, sig);
    });
    return el;
  }

  function markText(list) {
    const last = list[list.length - 1];
    const label = last.label || 'Session';
    const head = list.length > 1 ? `${label} +${list.length - 1}` : label;
    const status = statusText(last.status);
    return status ? `${head} · ${status}` : head;
  }

  /** How far the session has got, in the fewest words that say it. */
  function statusText(status) {
    if (!status) return '';
    const bits = [];
    switch (status.state) {
      case 'working': bits.push('working'); break;
      case 'answered': bits.push('answered'); break;
      case 'committed': bits.push(`${status.commits} commit${status.commits === 1 ? '' : 's'}`); break;
      case 'pr-open': bits.push(status.pr ? `PR #${status.pr.number}` : 'PR open'); break;
      case 'pr-closed': bits.push('PR closed'); break;
      case 'merged': bits.push('merged'); break;
      case 'gone': bits.push('cleaned up'); break;
      default: break;
    }
    if (status.reply) bits.push('reply ready');
    return bits.join(' · ');
  }

  function statusTitle(entry) {
    const status = entry.status;
    if (!status || !status.state) return '';
    const lines = [];
    if (status.commits) lines.push(`${status.commits} commit${status.commits === 1 ? '' : 's'} on the branch`);
    if (status.dirty) lines.push('uncommitted changes in the worktree');
    if (status.pr) lines.push(`${status.state === 'merged' ? 'merged' : status.state === 'pr-closed' ? 'closed' : 'open'}: ${status.pr.url}`);
    if (status.reply) lines.push('the agent left a reply for the thread');
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- inline */

  /*
   * A message's result line and session mark are part of the message: one
   * element of sidequest's own, right after the message's content, the way
   * Slack puts reactions under the words. It scrolls with the message and is
   * never repositioned, so there is nothing to follow the pointer around.
   *
   * This is the one place the overlay writes into Slack's DOM, and it is kept
   * to that single node: an unknown tag, so no rule of Slack's matches it,
   * with a shadow root holding the chip and its stylesheet, so nothing of
   * ours matches Slack. Slack's list measures its rows as they change, which
   * is how a reaction appearing grows its message; this grows it the same
   * way. Keyed by message like everything else, so a recycled row loses the
   * chip with the message it belonged to, and one Slack throws away on a
   * re-render is put back on the next pass.
   */
  const INLINE_TAG = 'sidequest-inline';
  /** Keyed by message: { host, result, mark }. */
  const inlines = new Map();

  function buildInline(sig) {
    const host = document.createElement(INLINE_TAG);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = INLINE_CSS;
    const result = buildResult(sig);
    const mark = buildMark(sig);
    root.append(style, result, mark);
    // A press on the chip is not a press on the message: Slack would take it
    // as the start of a selection, or a click to open the thread.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    return { host, result, mark };
  }

  function placeInline(bySig) {
    for (const [sig, inline] of inlines) {
      const row = bySig.get(sig);
      if (!row || !(results.has(sig) || sessionsFor(sig).length > 0)) {
        inline.host.remove();
        inlines.delete(sig);
      }
    }
    for (const [sig, row] of bySig) {
      const entry = results.get(sig);
      const list = sessionsFor(sig);
      if (!entry && list.length === 0) continue;
      const content = row.querySelector(SEL.content);
      if (!content || !content.parentNode) continue;

      let inline = inlines.get(sig);
      if (!inline) {
        inline = buildInline(sig);
        inlines.set(sig, inline);
      }
      // Right after the words, in whichever row holds the message now.
      if (content.nextSibling !== inline.host) content.after(inline.host);

      const { result, mark } = inline;
      if (entry) {
        show(result);
        hide(mark);
        const text = result.firstChild;
        if (text.textContent !== entry.text) {
          text.textContent = entry.text;
          result.title = entry.branch ? `Click to ${reopenHint(entry.branch)}.` : '';
        }
        if (result.dataset.kind !== entry.kind) result.dataset.kind = entry.kind;
        continue;
      }

      hide(result);
      show(mark);
      const text = markText(list);
      if (mark.textContent !== text) {
        mark.textContent = text;
        const last = list[list.length - 1];
        const detail = statusTitle(last);
        mark.title = `Sidequested → ${last.branch}` +
          (list.length > 1 ? ` (and ${list.length - 1} more)` : '') +
          (detail ? `\n${detail}` : '') +
          (last.status && last.status.reply ? '\nClick to review the reply.' : `\nClick to ${reopenHint('it')}.`);
        const state = (last.status && last.status.state) || '';
        if (state) mark.dataset.state = state;
        else delete mark.dataset.state;
        if (last.status && last.status.reply) mark.dataset.reply = '1';
        else delete mark.dataset.reply;
      }
    }
  }

  /* --------------------------------------------------------------- replies */

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
          return ask({ op: 'result-posted', branch, resultMs: res.resultMs });
        }).catch((err) => {
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
    const count = document.createElement('span');
    count.className = 'sq-reply-count';
    hide(count);
    button.append(dot, icon, label, count);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
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

  /* -------------------------------------------------------- sessions panel */

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

  /** What is cheaply known about a session, as [text, tone, tooltip]. */
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
      chips.push(['reply ready', 'reply', 'The agent left a reply for the thread. It is listed at the top.']);
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
    for (const [text, tone, tip] of sessionChips(s)) {
      const chip = document.createElement('span');
      chip.className = 'sq-chip';
      if (tone) chip.dataset.tone = tone;
      chip.textContent = text;
      chip.title = tip;
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
    // First, so the pill below sees the chips it has to keep clear of.
    placeInline(bySig);

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
      const activeChannel = channelFor(activeRow);
      // Looked up while the pointer is on the row, so the menu has it by the click.
      if (!activeChannel) resolveChannel(activeRow).then((name) => name && schedule());
      const flag = isLinked(activeChannel) ? '1' : '0';
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

    placeToast(clip);
    refreshChannelButton();
    placeSessions();
  }

  /* -------------------------------------------------------------- triggers */

  const fromOverlay = (target) => Boolean(
    target && target.nodeType === 1 && (
      (host && (target === host || host.contains(target))) || target.localName === INLINE_TAG
    ),
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
    closeSessions();
    schedule();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMenu();
    closePanel();
    closeSessions();
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
    // The one chord the overlay answers wherever focus is, the composer
    // included; stopped here so Slack never takes it for a keystroke.
    if (isSessionsKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleSessions();
      return;
    }
    if (menuKeys(event) || sessionsKeys(event)) {
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
