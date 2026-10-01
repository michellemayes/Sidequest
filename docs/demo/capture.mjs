// Records the README demo end to end: the real client/inject.js running over
// page.html (a mock of the Slack desktop app, keeping the DOM hooks the overlay
// reads), then the Warp tab it opens with Claude Code working in the new
// worktree, then back to Slack with the branch linked under the message.
// The daemon is stubbed to answer with a branch name, and the terminal is
// scripted (Claude Code's own layout, glyphs and colours, replayed line by
// line), so no worktree, Warp or agent is involved.
//
//   npm i --no-save playwright-core && node docs/demo/capture.mjs
//   python3 docs/demo/make_gif.py      # frames/ -> demo.gif (needs ffmpeg; see make_gif.py)
//
// Chromium comes from CHROME_PATH, else Playwright's own install. It also
// rewrites menu.png, the still of the open menu used further down the README.
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(HERE, 'frames');
const BRANCH = 'fix/checkout-total-is-wrong-20260930-1426';
const WORKTREE = '~/.sidequest/worktrees/fix-checkout-total-is-wrong-20260930-1426';
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

/** A Chromium Playwright installed, when CHROME_PATH does not name one. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    join(homedir(), '.cache/ms-playwright'), join(homedir(), 'Library/Caches/ms-playwright')].filter(Boolean);
  const bins = ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const bin of bins) if (existsSync(join(root, dir, bin))) return join(root, dir, bin);
    }
  }
  return undefined; // let Playwright look
}

const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
await page.goto('file://' + join(HERE, 'page.html'));
await page.evaluate(() => document.fonts.ready);

await page.evaluate((branch) => {
  window.__SIDEQUEST_CONFIG = {
    prompts: [
      { key: 'investigate', label: 'Investigate' },
      { key: 'fix', label: 'Fix' },
      { key: 'review', label: 'Review' },
    ],
    linkedChannels: ['bugs-storefront'],
    repoLabels: { 'bugs-storefront': ['storefront'] },
    agentLabel: 'Claude Code',
    stats: { total: 11, today: 1, streak: 4 },
  };
  window.__sidequestAsk = (json) => {
    const req = JSON.parse(json);
    const reply = { id: req.id, ok: true, branch, stats: { total: 12, today: 2, streak: 4 } };
    setTimeout(() => window.__sidequestResult(JSON.stringify(reply)), 450);
  };
  // Headless Chromium draws no pointer; draw a macOS-style one above everything.
  const cursor = document.createElement('div');
  cursor.id = 'cursor';
  cursor.innerHTML = '<svg width="20" height="28" viewBox="0 0 20 28"><path d="M2 2v20.5l5.2-5 3.6 8.3 3.3-1.4-3.6-8.2h7.3z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(cursor.style, { position: 'fixed', left: '-2px', top: '-2px', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))', transition: 'opacity .2s' });
  document.documentElement.appendChild(cursor);
  addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
}, BRANCH);
await page.addScriptTag({ content: await readFile(join(HERE, '../../client/inject.js'), 'utf8') });

// Every frame carries its own duration, so a hold is one long frame.
const manifest = [];
let n = 0;
const frame = async (ms = 50) => {
  const file = `${String(n++).padStart(4, '0')}.png`;
  await page.screenshot({ path: join(FRAMES, file) });
  manifest.push({ file, ms });
};
const hold = async (ms) => { await page.waitForTimeout(40); await frame(ms); };
// Several short frames, for anything animating on its own (toasts, transitions).
const watch = async (ms, step = 60) => { for (let t = 0; t < ms; t += step) { await page.waitForTimeout(step); await frame(step); } };

let pos = { x: 1060, y: 610 };
const glide = async (x, y, steps = 14) => {
  const from = pos;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await frame(28);
  }
  pos = { x, y };
};
const center = async (locator) => {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const click = async () => { await page.mouse.down(); await page.mouse.up(); };
const caption = (step, text) => page.evaluate(([s, t]) => {
  document.getElementById('step').textContent = s;
  document.getElementById('captext').textContent = t;
}, [String(step), text]);
const cursorShown = (on) => page.evaluate((v) => { document.getElementById('cursor').style.opacity = v ? '1' : '0'; }, on);

/* ------------------------------------------------------------ 1. Slack */
await caption(1, 'Someone reports a bug in Slack. Hover the message and pick Fix.');
await page.mouse.move(pos.x, pos.y);
await hold(700);
const bug = page.locator('#bug');
const bugBox = await bug.boundingBox();
await glide(bugBox.x + bugBox.width * 0.62, bugBox.y + 34, 16);   // onto Priya's message
await hold(500);                                                     // Slack's hover actions and the Sidequest pill
const launch = page.locator('.sq-launch');
await launch.waitFor({ state: 'visible' });
await glide(...(await center(launch)), 12);
await hold(250);
await click();
await watch(240);
const fix = page.locator('.sq-menu-prompt', { hasText: 'Fix' });
await glide(...(await center(fix)), 9);
await hold(650);
// The README's still of the menu, without the caption.
await page.evaluate(() => { document.querySelector('.caption').style.visibility = 'hidden'; });
await page.screenshot({ path: join(HERE, 'menu.png') });
await page.evaluate(() => { document.querySelector('.caption').style.visibility = ''; });
await click();
// Off the messages, so no row's hover actions sit over what lands next.
const today = await page.locator('.divider', { hasText: 'Today' }).boundingBox();
const aside = [today.x + today.width - 90, today.y + today.height / 2];
await glide(...aside, 10);
await page.locator('.sq-result').waitFor();
await watch(420);                      // toast pops in, branch appears under the message
await hold(1500);

/* ------------------------------------------------------------- 2. Warp */
await caption(2, 'A Warp tab opens on a fresh worktree, with Claude Code already on it.');
await cursorShown(false);
await page.evaluate(() => {
  const w = document.getElementById('warp');
  w.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => w.classList.remove('off')));
});
await watch(420);

// The terminal. #term is the transcript, #live the spinner and input box
// Claude Code keeps redrawing under it; the screen sticks to the bottom.
await page.evaluate(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const s = { spin: null, tick: 0, secs: 0, tokens: 0 };
  const term = document.getElementById('term');
  const live = document.getElementById('live');
  const screen = document.getElementById('screen');
  const stick = () => { screen.scrollTop = screen.scrollHeight; };
  const render = () => {
    const spin = s.spin
      ? `<div class="ln spin"><span>${GLYPHS[s.tick % GLYPHS.length]}</span> <span class="word">${s.spin}…</span> <span class="dim">(${s.secs}s · ↑ ${s.tokens >= 1000 ? (s.tokens / 1000).toFixed(1) + 'k' : s.tokens} tokens · <b>esc</b> to interrupt)</span></div>`
      : '';
    live.innerHTML = `${spin}<div class="input"><span>&gt;&nbsp;</span><span class="caret"></span></div>` +
      `<div class="hint"><span>? for shortcuts</span></div>`;
    stick();
  };
  window.__cc = {
    esc,
    add(html) { term.insertAdjacentHTML('beforeend', html); stick(); return term.lastElementChild; },
    spin(word) { s.spin = word; render(); },
    tick(dt = 0.35) { s.tick++; s.secs += dt; s.tokens += Math.round(40 + Math.random() * 90); render(); },
    title(t) { document.getElementById('wtitle').textContent = t; },
    done(el, cls) { const b = el.querySelector('.bul'); b.className = 'bul ' + cls; stick(); },
    render,
  };
  s.secs = 0;
  render();
  // Round seconds for display.
  const orig = window.__cc.tick;
  window.__cc.tick = (dt) => { orig(dt); const el = live.querySelector('.spin .dim'); if (el) el.innerHTML = el.innerHTML.replace(/\((\d+)\.\d+s/, '($1s'); };
});

const cc = (fn, ...args) => page.evaluate(([f, a]) => window.__cc[f](...a), [fn, args]);
const add = (html) => cc('add', html);
const E = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Spinner frames: the glyph turns and the counters climb while the agent works.
const think = async (ms, step = 110) => { for (let t = 0; t < ms; t += step) { await cc('tick', step / 1000 * 2.2); await frame(step); } };

const ln = (html, cls = '') => `<div class="ln ${cls}">${html}</div>`;
const text = (html) => ln(`<span class="bul text"></span>${html}`);
const toolRun = (name, arg) => ln(`<span class="bul run"></span><span class="b">${name}</span>${arg ? `(${E(arg)})` : ''}`);
const out = (html) => ln(`<span class="elbow"></span>${html}`, 'in4');
const more = (html) => ln(`     ${html}`, 'in4');
const gap = ln('', 'sp');
const diff = (rows) => `<div class="diff">${rows.map(([kind, num, code]) => {
  const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
  return `<div class="ln ${kind}"><span class="n">${String(num).padStart(4)}</span> ${sign} ${E(code)}</div>`;
}).join('')}</div>`;

// A tool call: grey and blinking while it runs, then green (or red) with its result.
const tool = async (name, arg, result, { runMs = 520, after = 380, fail = false } = {}) => {
  await add(gap + toolRun(name, arg));
  await think(runMs);
  await page.evaluate(([html, cls]) => {
    const term = document.getElementById('term');
    const lines = term.querySelectorAll('.ln');
    let head = null;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].querySelector('.bul.run')) { head = lines[i]; break; }
    head.querySelector('.bul').className = 'bul ' + cls;
    term.insertAdjacentHTML('beforeend', html);
    document.getElementById('screen').scrollTop = 1e9;
  }, [result, fail ? 'fail' : 'tool']);
  await think(after);
};

await hold(250);
await add(`<div class="welcome">${[
  '<span class="o">✻</span> <span class="b">Welcome to Claude Code!</span>',
  '',
  '  <span class="dim"><i style="font-style:italic">/help</i> for help, <i style="font-style:italic">/status</i> for your current setup</span>',
  '',
  `  <span class="dim">cwd: ${WORKTREE.replace('~', '/Users/michelle')}</span>`,
].map((l) => ln(l)).join('')}</div>`);
await hold(600);

await add(`<div class="user">${[
  '&gt; You are fixing an issue reported in Slack.',
  '',
  '## The report',
  'From @Priya Shah in #bugs-storefront on Sep 30, 2026:',
  'Checkout totals are wrong when a gift card covers part of an order. We charge VAT on the full cart *before* the gift card comes off, so customers get overcharged :grimacing:',
  'Repro on the EU store: order #48213, €60 cart with a €50 gift card was charged €22 instead of €12.',
  '',
  'Slack permalink: https://acme.slack.com/archives/C0BUGS/p1759240800000100',
  '',
  '## What I need',
  '1. Find the root cause before changing anything — do not patch the symptom.',
  '2. Make the smallest change that actually fixes it.',
  '3. Add or update a test that fails without your fix and passes with it.',
  '4. Run the repo\'s own lint, typecheck and test commands and get them green.',
  `5. Commit on this branch (${BRANCH}) with a message explaining the cause, not just the change.`,
].map((l, i) => ln(i === 0 ? l : '  ' + l)).join('')}</div>`);
await cc('spin', 'Pondering');
await cc('title', '✳ Checkout VAT with gift cards');
await think(900);

await add(gap + text('I\'ll start by finding where the checkout total is computed.'));
await think(300);
await tool('Search', 'pattern: "applyVat|giftCard", path: "src/pricing"',
  out('Found <span class="b">3</span> files') + more('<span class="dim">src/pricing/totals.ts</span>') + more('<span class="dim">src/pricing/vat.ts</span>') + more('<span class="dim">src/pricing/totals.test.ts</span>'));
await tool('Read', 'src/pricing/totals.ts', out('Read <span class="b">142</span> lines <span class="dim">(ctrl+r to expand)</span>'), { after: 500 });
await cc('spin', 'Reticulating');
await think(500);
await add(gap + text('Found it. <span class="blue">computeTotal()</span> applies VAT to the full subtotal and subtracts the gift card afterwards, so the part of the order paid by gift card is still taxed: €60 × 1.2 − €50 = €22, where (€60 − €50) × 1.2 = €12 is right.'));
await think(700);

await tool('Update Todos', '', [
  out('<span class="cb">☐</span> Add a failing test for a partial gift card on the EU store'),
  more('<span class="cb">☐</span> Apply VAT to what is left after the gift card'),
  more('<span class="cb">☐</span> Run lint, typecheck and the tests'),
  more('<span class="cb">☐</span> Commit the fix'),
].join(''), { runMs: 250, after: 420 });

await tool('Update', 'src/pricing/totals.test.ts',
  out('Updated <span class="b">src/pricing/totals.test.ts</span> with <span class="b">7</span> additions') + diff([
    ['ctx', 88, '  });'],
    ['add', 89, ''],
    ['add', 90, "  it('taxes only what is left after a gift card', () => {"],
    ['add', 91, "    const cart = eurCart([{ price: 60 }]);"],
    ['add', 92, "    expect(computeTotal(cart, { giftCard: 50 })).toBe(12);"],
    ['add', 93, '  });'],
  ]), { runMs: 450, after: 450 });

await tool('Bash', 'npx vitest run src/pricing/totals.test.ts', [
  out('<span class="err">FAIL</span>  src/pricing/totals.test.ts &gt; taxes only what is left after a gift card'),
  more('<span class="err">AssertionError: expected 22 to be 12</span>'),
  more('<span class="dim">Tests  <span class="err">1 failed</span> | 48 passed (49)</span>'),
].join(''), { runMs: 700, after: 450, fail: true });
await add(gap + text('The new test fails exactly the way Priya described. Now the fix:'));
await think(350);

await tool('Update', 'src/pricing/totals.ts',
  out('Updated <span class="b">src/pricing/totals.ts</span> with <span class="b">2</span> additions and <span class="b">2</span> removals') + diff([
    ['ctx', 58, '  const subtotal = sumLines(cart.lines);'],
    ['del', 59, '  const taxed = applyVat(subtotal, cart.region);'],
    ['del', 60, '  return taxed - giftCard;'],
    ['add', 59, '  const due = Math.max(subtotal - giftCard, 0);'],
    ['add', 60, '  return applyVat(due, cart.region);'],
    ['ctx', 61, '}'],
  ]), { runMs: 450, after: 650 });

await tool('Bash', 'npm run lint && npm run typecheck && npm test', [
  out('<span class="ok">✓</span> src/pricing/totals.test.ts <span class="dim">(49 tests)</span> 41ms'),
  more('<span class="dim">Test Files</span>  <span class="ok">6 passed</span> <span class="dim">(6)</span>'),
  more('<span class="dim">     Tests</span>  <span class="ok">212 passed</span> <span class="dim">(212)</span>'),
  more('<span class="dim">… +9 lines (ctrl+r to expand)</span>'),
].join(''), { runMs: 900, after: 400 });

await tool('Bash', 'git commit -am "Apply VAT after the gift card, not before"', [
  out(`[${BRANCH} 3f9c2ab] Apply VAT after the gift card, not before`),
  more(' 2 files changed, 7 insertions(+), 2 deletions(-)'),
].join(''), { runMs: 450, after: 300 });

await tool('Update Todos', '', [
  out('<span class="todo-done"><span class="cb">☒</span> Add a failing test for a partial gift card on the EU store</span>'),
  more('<span class="todo-done"><span class="cb">☒</span> Apply VAT to what is left after the gift card</span>'),
  more('<span class="todo-done"><span class="cb">☒</span> Run lint, typecheck and the tests</span>'),
  more('<span class="todo-done"><span class="cb">☒</span> Commit the fix</span>'),
].join(''), { runMs: 200, after: 300 });

await cc('spin', null);
await add(gap + text(`Fixed and committed on <span class="b">${BRANCH}</span>. VAT is now charged on what is left after the gift card, so #48213 comes to €12. The new regression test failed before the fix and passes now; lint, typecheck and all 212 tests are green.`));
await cc('title', '✳ Checkout VAT with gift cards');
await hold(2000);

/* ------------------------------------------------------------ 3. Slack */
await caption(3, 'Back in Slack, the branch is linked under the message. Click it to reopen.');
await page.evaluate(() => document.getElementById('warp').classList.add('off'));
await watch(360);
await page.evaluate(() => { document.getElementById('warp').hidden = true; });
pos = { x: aside[0], y: aside[1] };
await page.mouse.move(pos.x, pos.y);
await cursorShown(true);
const result = page.locator('.sq-result');
await glide(...(await center(result)), 16);
await hold(2400);

await browser.close();
await writeFile(join(FRAMES, 'manifest.json'), JSON.stringify(manifest));
console.log(`${n} frames, ${(manifest.reduce((a, f) => a + f.ms, 0) / 1000).toFixed(1)}s`);
