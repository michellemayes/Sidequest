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
