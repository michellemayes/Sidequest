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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('sidequest did not answer'));
    }, OP_TIMEOUT_MS[payload.op] || REQUEST_TIMEOUT_MS);
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
