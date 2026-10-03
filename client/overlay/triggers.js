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
