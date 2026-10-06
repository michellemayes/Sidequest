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
    if (CONFIG.reactions) {
      react(meta.permalink, 'eyes').catch((err) => log('could not react', err.message));
    }
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

/**
 * Call Slack's web API on this page's own origin. The workspace hosts
 * (team.url) answer with "Access-Control-Allow-Origin: *", which a browser
 * refuses for a request that carries cookies: the post still goes out, but
 * its answer is withheld and fetch says "Failed to fetch". Same-origin, the
 * session cookie rides along and the answer can be read. The token in the
 * form says which workspace.
 */
function slackApi(method, form) {
  return fetch(new URL(`/api/${method}`, location.origin).href, {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Post in the thread as you, to the workspace's own API and nowhere else.
 * If the request goes out but its answer never comes back, the post is
 * taken as sent: in practice it always lands.
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
  form.append('client_msg_id', newClientMsgId());
  let res;
  let body;
  try {
    res = await slackApi('chat.postMessage', form);
    body = await res.json();
  } catch (err) {
    if (res && !res.ok) throw new Error(`Slack said HTTP ${res.status}.`);
    log('replied in thread (Slack\'s answer was lost)', target, err.message);
    return;
  }
  if (!body || !body.ok) throw new Error(`Slack said ${(body && body.error) || `HTTP ${res.status}`}.`);
  log('replied in thread', target);
}

/** The message a permalink names, for reacting to it: its channel and its own ts. */
function reactionTarget(permalink) {
  const match = String(permalink || '').match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  return match ? { channel: match[1], ts: `${match[2]}.${match[3]}` } : null;
}

/*
 * What Slack answers when a reaction is already as asked: there, or (on
 * remove) not there. Either way the message says what it should.
 */
const REACTION_SETTLED = ['already_reacted', 'no_reaction'];

/**
 * React to a message as you, or take a reaction of yours off it, through
 * the workspace's own API like a reply. Settings.reactions decides whether
 * this happens at all; callers check it.
 */
async function react(permalink, name, remove = false) {
  const target = reactionTarget(permalink);
  if (!target) throw new Error('Slack gave that message no link to react to.');
  const team = slackTeam(permalink);
  if (!team) throw new Error('Could not find which Slack workspace this window is signed in to.');
  const form = new FormData();
  form.append('token', team.token);
  form.append('channel', target.channel);
  form.append('timestamp', target.ts);
  form.append('name', name);
  const res = await slackApi(remove ? 'reactions.remove' : 'reactions.add', form);
  const body = await res.json();
  if (!body || (!body.ok && !REACTION_SETTLED.includes(body.error))) {
    throw new Error(`Slack said ${(body && body.error) || `HTTP ${res.status}`}.`);
  }
  log(remove ? 'unreacted' : 'reacted', name, target);
}

/** The session is done with its message: 👀 off, `name` on. */
async function reactDone(permalink, name = 'white_check_mark') {
  await react(permalink, 'eyes', true).catch((err) => log('could not unreact', err.message));
  await react(permalink, name);
}

/*
 * The daemon asks one window to mark how a session ended (merged, failed);
 * true means this window took it on. See reactToOutcomes in attacher.ts.
 */
window.__sidequestReact = (json) => {
  let job;
  try {
    job = JSON.parse(json);
  } catch {
    return false;
  }
  if (!job || !job.permalink || !job.name || !slackTeam(job.permalink)) return false;
  reactDone(job.permalink, job.name).catch((err) => log('could not react', err.message));
  return true;
};

function newClientMsgId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
