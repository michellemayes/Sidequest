/**
 * The moment a session lands is worth marking. Counting them — this one's
 * number, how many today, how many days running — turns a tool you reach
 * for into a habit you keep, and the milestones are there to be hit.
 */
function celebrate(prompt, res) {
  const s = res.stats;
  const where = res.warning
    ? (CONFIG.headless ? 'Worktree ready — the agent did not start' : `Worktree ready — ${CONFIG.agentHost} did not open`)
    : CONFIG.agentInApp
      ? `Prompt ready in ${CONFIG.agentHost} — press Enter there to start`
      : CONFIG.headless
        ? `${CONFIG.agentLabel} is working in the background`
        : `${CONFIG.agentLabel} is starting in ${CONFIG.agentHost}`;
  if (!s) {
    toast({ title: `${prompt.label} is underway`, sub: CONFIG.skipPermissions ? `${where} · permission prompts off` : where, burst: true });
    return;
  }
  let title;
  if (s.total === 1) title = 'Your first sidequest is underway';
  else if (s.milestone) title = `Sidequest #${s.total} — milestone!`;
  else if (s.firstToday && s.streak >= 2) title = `${s.streak}-day streak — sidequest #${s.total}`;
  else title = `Sidequest #${s.total} is underway`;

  const bits = [where];
  if (CONFIG.skipPermissions && !res.warning) bits.push('permission prompts off');
  if (s.today > 1) bits.push(`${s.today} today`);
  if (s.streak >= 2 && !(s.firstToday && title.includes('streak'))) bits.push(`🔥 ${s.streak}-day streak`);
  toast({ title, sub: bits.join(' · '), burst: true, big: Boolean(s.milestone) || s.total === 1 });
}

function toast({ title, sub = '', kind = 'info', burst = false, big = false, action = null }) {
  if (!ensureLayer()) return;
  clearTimeout(toastTimer);
  toastEl?.remove();

  const el = document.createElement('div');
  el.className = 'sq-toast';
  el.dataset.kind = kind;
  el.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'sq-toast-icon';
  icon.innerHTML = iconSvg();
  if (burst) {
    const colors = ['#a78bfa', '#7c3aed', '#f472b6', '#facc15', '#34d399'];
    const count = big ? 16 : 10;
    for (let i = 0; i < count; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'sq-spark';
      spark.style.setProperty('--a', `${Math.round((360 / count) * i)}deg`);
      spark.style.setProperty('--c', colors[i % colors.length]);
      spark.style.animationDelay = `${(i % 3) * 40}ms`;
      icon.append(spark);
    }
  }

  const body = document.createElement('div');
  body.className = 'sq-toast-body';
  const head = document.createElement('div');
  head.className = 'sq-toast-title';
  head.textContent = title;
  body.append(head);
  if (sub) {
    const line = document.createElement('div');
    line.className = 'sq-toast-sub';
    line.textContent = sub;
    line.title = sub;
    body.append(line);
  }
  el.append(icon, body);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sq-toast-action';
    button.textContent = action.label;
    button.addEventListener('click', (event) => {
      stop(event);
      dismiss();
      action.run();
    });
    el.append(button);
  }

  const dismiss = () => {
    if (toastEl !== el) return;
    el.dataset.leaving = '1';
    setTimeout(() => {
      el.remove();
      if (toastEl === el) toastEl = null;
    }, 250);
  };
  el.addEventListener('click', (event) => {
    stop(event);
    dismiss();
  });
  // Reading it is a reason to keep it up.
  el.addEventListener('mouseenter', () => clearTimeout(toastTimer));
  el.addEventListener('mouseleave', () => { toastTimer = setTimeout(dismiss, 1800); });

  toastEl = el;
  ui.append(el);
  toastTimer = setTimeout(dismiss, kind === 'error' || action ? TOAST_MS * 2 : TOAST_MS);
  schedule();
}

/** Top centre of the message list: where the eye already is. */
function placeToast(clip) {
  if (!toastEl) return;
  const area = clip || { top: 0, left: 0, right: window.innerWidth };
  const header = document.querySelector(SEL.header);
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const top = Math.max(area.top, headerBottom) + 12;
  const left = area.left + ((area.right - area.left) - toastEl.offsetWidth) / 2;
  placeAt(toastEl, left, top);
}
