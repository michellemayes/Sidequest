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

/*
 * Where the chip goes in a row, as [parent, before]: over the thread's
 * "N replies" bar when there is one, so it sits under the words, the
 * attachments and the reactions alike. Otherwise right after the content,
 * unless the content is one column of a row laid out sideways (the avatar
 * gutter and the message beside it), where a sibling would land off to the
 * right of the message; then at the end of the content itself.
 */
function inlineSpot(row, content) {
  const bar = row.querySelector(SEL.replyBar);
  if (bar && bar.parentNode) return [bar.parentNode, bar];
  const outer = getComputedStyle(content.parentNode);
  const sideways = /flex/.test(outer.display) ? !/column/.test(outer.flexDirection) : /grid/.test(outer.display);
  return sideways ? [content, null] : [content.parentNode, content.nextSibling];
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
    // Under the message, in whichever row holds the message now.
    const [parent, before] = inlineSpot(row, content);
    if (inline.host.parentNode !== parent || inline.host.nextSibling !== before) {
      parent.insertBefore(inline.host, before);
    }

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
