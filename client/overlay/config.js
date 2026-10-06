/*
 * sidequest overlay — runs inside the Slack desktop app's renderer.
 *
 * Injected over CDP by src/cdp/attacher.ts, which also installs the
 * __sidequestAsk binding this talks to. Every request goes down to the local
 * daemon and comes back through __sidequestResult. The exceptions are thread
 * replies, which go to Slack's own API as you (see postReply in start.js):
 * the one a session posts when settings.autoReply is on, and the agent's
 * reply under settings.postResults; with settings.reactions on, 👀, ✅ and ❌
 * on a session's message; and, with settings.sync on, the settings
 * note in your DM with yourself (sync.js).
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
 * after a message's content, holding its own shadow root (see inline.js): it grows
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
  reactions: false,
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
/*
 * How long a request waits for the daemon. Starting a session can mean a
 * fetch over a slow link, so it waits far longer than a UI request normally
 * would; so can the few that run git or open a terminal. Everything else is
 * a config or file read that answers in milliseconds, and a daemon that has
 * not answered one in ten seconds is not going to, so say so rather than
 * leave a spinner up for two minutes.
 */
const REQUEST_TIMEOUT_MS = 10000;
const OP_TIMEOUT_MS = {
  'start-session': 120000,
  reopen: 60000,
  'remove-session': 60000,
  'suggest-repos': 60000,
  'link-repo': 30000,
  'list-sessions': 30000,
  // A push and gh, each over the network.
  'open-pr': 180000,
  // Opens the terminal, like reopen.
  'follow-up': 60000,
};
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
  replyBar: '.c-message__reply_bar, [data-qa="reply_bar"]',
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


/*
 * The stylesheets live beside this file (tokens.css, overlay.css, inline.css)
 * and arrive as STYLES, put together by src/cdp/overlay.ts.
 */
const CSS = STYLES.tokens + STYLES.overlay;
const INLINE_CSS = STYLES.tokens + STYLES.inline;
