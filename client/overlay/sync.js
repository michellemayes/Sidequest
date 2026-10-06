/*
 * Settings sync (settings.sync; see src/config/sync.ts). The daemon owns
 * the merge and writes the note's text; all the page does is find the note
 * and save it, because only the page is signed in to Slack. The note is a
 * pinned message in your DM with yourself, read and written through Slack's
 * API as you, like a thread reply. The daemon calls these two directly and
 * awaits them; nothing in the overlay's own UI does.
 */

/* src/config/sync.ts writes the same string into every note. */
const SYNC_MARKER = 'sidequest-sync:v1';

async function slackCall(team, method, fields) {
  const form = new FormData();
  form.append('token', team.token);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const res = await slackApi(method, form);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: say what HTTP said instead.
  }
  if (!body || !body.ok) throw new Error(`Slack said ${(body && body.error) || `HTTP ${res.status}`} to ${method}.`);
  return body;
}

const isNote = (message) => Boolean(message && message.ts && String(message.text || '').includes(SYNC_MARKER));
const newestFirst = (a, b) => Number(b.ts) - Number(a.ts);

/**
 * Your DM with yourself, and the note in it: the newest pinned one, or,
 * if it was unpinned by hand, the newest among the recent messages there.
 */
window.__sidequestSyncRead = async () => {
  const team = slackTeam();
  if (!team) return { ok: false, error: 'Could not find which Slack workspace this window is signed in to.' };
  try {
    const me = await slackCall(team, 'auth.test', {});
    const dm = await slackCall(team, 'conversations.open', { users: me.user_id });
    const channel = dm.channel && dm.channel.id;
    if (!channel) throw new Error('Slack did not open your DM with yourself.');
    const pins = await slackCall(team, 'pins.list', { channel });
    const pinned = (pins.items || []).map((item) => item.message).filter(isNote).sort(newestFirst);
    let note = pinned[0] ? { ts: pinned[0].ts, text: pinned[0].text, pinned: true } : null;
    if (!note) {
      const history = await slackCall(team, 'conversations.history', { channel, limit: '200' });
      const found = (history.messages || []).filter(isNote).sort(newestFirst)[0];
      if (found) note = { ts: found.ts, text: found.text, pinned: false };
    }
    // Older pinned notes are left from a workspace that stops edits after a
    // while; the write that replaced them takes them down.
    const stale = pinned.slice(1).map((m) => m.ts);
    return { ok: true, channel, note, stale };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

/**
 * Save the note: edit it in place, or post it (and pin it) when there is
 * none, or when the workspace no longer lets it be edited. A note replaced
 * that way, and any stale ones, are unpinned so the newest is the only one.
 */
window.__sidequestSyncWrite = async (json) => {
  let job;
  try {
    job = JSON.parse(json);
  } catch {
    return { ok: false, error: 'bad sync job' };
  }
  const team = slackTeam();
  if (!team) return { ok: false, error: 'Could not find which Slack workspace this window is signed in to.' };
  const { channel, text } = job;
  const unpin = (ts) => slackCall(team, 'pins.remove', { channel, timestamp: ts }).catch(() => {});
  try {
    if (job.ts) {
      try {
        await slackCall(team, 'chat.update', { channel, ts: job.ts, text });
        if (!job.pinned) await slackCall(team, 'pins.add', { channel, timestamp: job.ts }).catch(() => {});
        await Promise.all((job.stale || []).map(unpin));
        return { ok: true, ts: job.ts };
      } catch (err) {
        // Gone, or past the workspace's edit window: post a new one instead.
        if (!/message_not_found|cant_update_message|edit_window_closed/.test(err.message)) throw err;
      }
    }
    const posted = await slackCall(team, 'chat.postMessage', { channel, text, client_msg_id: newClientMsgId() });
    await slackCall(team, 'pins.add', { channel, timestamp: posted.ts }).catch(() => {});
    await Promise.all([job.ts, ...(job.stale || [])].filter(Boolean).map(unpin));
    log('saved synced settings', posted.ts);
    return { ok: true, ts: posted.ts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};
