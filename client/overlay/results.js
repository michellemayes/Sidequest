/** Keyed by message, not by row, so scrolling away and back keeps the line. */
const results = new Map();

function setResult(sig, text, kind, branch = '') {
  if (!sig) return;
  results.delete(sig);
  results.set(sig, { text, kind, branch, at: Date.now() });
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
  schedule();
}

/*
 * The daemon answers a click once the terminal has opened, before the agent
 * has started in it. When it then does not start, that comes in with the
 * config, and goes on the line the click left under the message, as a
 * launch error in the answer would have. Only that line: another window,
 * or this one after a reload, has nothing to amend.
 */
const launchErrorsShown = new Set();
function announceLaunchErrors() {
  for (const [sig, list] of Object.entries(CONFIG.sessions || {})) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || !entry.launchError || launchErrorsShown.has(entry.branch)) continue;
      const line = results.get(sig);
      if (!line || line.branch !== entry.branch) continue;
      launchErrorsShown.add(entry.branch);
      setResult(sig, `${line.text} — ${entry.launchError}`, 'warn', entry.branch);
    }
  }
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
