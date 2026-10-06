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
  announceLaunchErrors();
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
  // Only the post itself can fail the reply: once Slack has it, a slow or
  // lost word back to the daemon is not a failed post.
  postReply(job.permalink, job.text).then(() => {
    toast({ title: `Replied in the thread for ${job.label || 'a session'}`, sub: job.branch });
    markPosted({ branch: job.branch, resultMs: job.resultMs });
    if (CONFIG.reactions) reactDone(job.permalink).catch((err) => log('could not react', err.message));
  }, (err) => {
    toast({ title: 'Could not post the reply', sub: err.message, kind: 'error' });
    ask({ op: 'result-posted', branch: job.branch, resultMs: job.resultMs, error: err.message }).catch(() => {});
  });
  return true;
};

/**
 * Tell the daemon a reply went out, so it is not offered or posted again.
 * Tried a few times, since a reply it never hears about comes back; never
 * throws, because the reply is out either way.
 */
async function markPosted(fields) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    try {
      const res = await ask(Object.assign({ op: 'result-posted' }, fields));
      if (!res.error) return;
    } catch {
      // The daemon is busy or the binding is reconnecting; try again.
    }
  }
  log('posted a reply but could not tell sidequest', fields.branch);
}

function ask(payload) {
  if (typeof window[ASK] !== 'function') {
    return Promise.reject(new Error('sidequest binding missing'));
  }
  const id = `r${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('sidequest did not answer'));
    }, OP_TIMEOUT_MS[payload.op] || REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      window[ASK](JSON.stringify(Object.assign({ id }, payload)));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}
