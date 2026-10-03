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
  const lookup = slackApi('conversations.info', form)
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
  // Downloaded side by side, then kept or dropped in the message's order,
  // so the size limits keep the same files as fetching them one by one.
  const blobs = await Promise.all(files.map(fetchFile));
  const kept = [];
  let total = 0;
  files.forEach((file, i) => {
    const blob = blobs[i];
    if (!blob) return;
    if (blob.size === 0 || blob.size > MAX_FILE_BYTES || total + blob.size > MAX_FILES_TOTAL) {
      log('could not fetch', file.url, `${blob.size} bytes is over the limit`);
      return;
    }
    total += blob.size;
    kept.push({ file, blob });
  });
  const encoded = await Promise.all(kept.map(({ file, blob }) => base64Of(blob).then(
    (data) => ({ name: file.name, type: blob.type, data }),
    (err) => {
      log('could not fetch', file.url, err.message);
      return null;
    },
  )));
  return encoded.filter(Boolean);
}

/** One file's contents, or null when it will not come in time or is not a file. */
async function fetchFile(file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);
  try {
    const res = await fetch(file.url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (/text\/html/i.test(blob.type)) throw new Error('got a page, not the file');
    return blob;
  } catch (err) {
    log('could not fetch', file.url, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
