// Records the README demo end to end: the real client/inject.js running over
// page.html (a Slack-shaped mock channel), then the Warp tab it opens with the
// agent working in the new worktree, then back to Slack with the branch linked.
// The daemon is stubbed to answer with a branch name, and the terminal is
// scripted, so no worktree, Warp or agent is involved.
//
//   npm i --no-save playwright-core && node docs/demo/capture.mjs
//   python3 docs/demo/make_gif.py      # frames/ -> demo.gif (needs ffmpeg; pip install imageio-ffmpeg and set FFMPEG if yours lacks it)
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(HERE, 'frames');
const BRANCH = 'fix/checkout-total-is-wrong-20260930-1426';
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, deviceScaleFactor: 2 });
await page.goto('file://' + join(HERE, 'page.html'));

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
    setTimeout(() => window.__sidequestResult(JSON.stringify(reply)), 500);
  };
  // Headless Chromium draws no pointer; draw one above everything.
  const cursor = document.createElement('div');
  cursor.innerHTML = '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1 1v20l5-5 4 9 3-1.4-4-8.6h7z" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>';
  Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none' });
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

let pos = { x: 1000, y: 540 };
const glide = async (x, y, steps = 14) => {
  const from = pos;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await frame(30);
  }
  pos = { x, y };
};
const center = async (locator) => {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const caption = (step, text) => page.evaluate(([s, t]) => {
  document.getElementById('step').textContent = s;
  document.getElementById('captext').textContent = t;
}, [String(step), text]);

/* ------------------------------------------------------------ 1. Slack */
await caption(1, 'Someone reports a bug in Slack. Hover it and pick Fix.');
await page.mouse.move(pos.x, pos.y);
await hold(1200);
await glide(640, 190);                 // onto Priya's message
await hold(300);
const launch = page.locator('.sq-launch');
await launch.waitFor({ state: 'visible' });
await glide(...(await center(launch)), 12);
await hold(300);
await page.mouse.down(); await page.mouse.up();
await watch(300);
const fix = page.locator('.sq-menu-prompt', { hasText: 'Fix' });
await glide(...(await center(fix)), 10);
await hold(700);
await page.screenshot({ path: join(HERE, 'menu.png') });
await page.mouse.down(); await page.mouse.up();
await page.locator('.sq-result').waitFor();
await watch(1500);                     // toast lands, branch appears under the message

/* ------------------------------------------------------------- 2. Warp */
await caption(2, 'A Warp tab opens on a fresh worktree, and Claude Code starts on it.');
await glide(1180, 630, 8);
await page.evaluate(() => {
  const w = document.getElementById('warp');
  w.classList.add('off'); w.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => w.classList.remove('off')));
});
await watch(420);

const say = (html) => page.evaluate((h) => {
  const term = document.getElementById('term');
  term.querySelector('.cursor')?.remove();
  const line = document.createElement('div');
  line.innerHTML = h;
  term.appendChild(line);
  const c = document.createElement('span');
  c.className = 'cursor';
  line.appendChild(c);
}, html);
const lines = async (list, ms) => { for (const l of list) { await say(l); await frame(ms); } };

await lines([
  '<span class="cc-box"><span class="o">✻</span> <span class="b">Welcome to Claude Code</span>  <span class="dim">cwd: fix-checkout-total-is-wrong-20260930-1426</span></span>',
], 500);
await lines([
  '<span class="dim">&gt;</span> You are fixing an issue reported in Slack.',
  '<span class="dim">  From @Priya Shah in #bugs-storefront: checkout total is wrong when a gift card</span>',
  '<span class="dim">  covers part of the order. The tax is calculated before the gift card is applied…</span>',
  '',
], 180);
await hold(600);
await lines([
  '<span class="o">⏺</span> <span class="b">Read</span>(pricing/totals.ts)',
  '<span class="dim">  ⎿  Read 142 lines</span>',
], 450);
await lines([
  '<span class="o">⏺</span> <span class="w">Root cause: <span class="b">applyVat()</span> runs on the pre-gift-card subtotal, so the</span>',
  '<span class="w">  EU path taxes money the customer never pays.</span>',
], 900);
await lines([
  '<span class="o">⏺</span> <span class="b">Update</span>(pricing/totals.ts)',
  '<span class="del">  61 -  const taxed = applyVat(subtotal, region);</span>',
  '<span class="del">  62 -  return taxed - giftCard;</span>',
  '<span class="add">  61 +  const due = Math.max(subtotal - giftCard, 0);</span>',
  '<span class="add">  62 +  return applyVat(due, region);</span>',
], 260);
await hold(700);
await lines([
  '<span class="o">⏺</span> <span class="b">Bash</span>(npm test -- totals)',
  '<span class="dim">  ⎿  </span><span class="g">✓ 49 passed</span><span class="dim"> (1 new: "taxes the amount left after a gift card")</span>',
], 650);
await lines([
  '<span class="o">⏺</span> <span class="b">Bash</span>(npm run lint &amp;&amp; npm run typecheck)',
  '<span class="dim">  ⎿  </span><span class="g">No problems</span>',
], 550);
await lines([
  '<span class="o">⏺</span> <span class="b">Bash</span>(git commit -am "Apply VAT after gift cards on EU checkout")',
  `<span class="dim">  ⎿  [${BRANCH} 3f9c2ab]</span>`,
], 700);
await lines([
  '',
  '<span class="o">⏺</span> <span class="w">Fixed and committed. Tax is now calculated on what is left after the gift card.</span>',
], 2400);

/* ------------------------------------------------------------ 3. Slack */
await caption(3, 'Back in Slack, the branch is linked under the message. Click it to reopen.');
await page.evaluate(() => document.getElementById('warp').classList.add('off'));
await watch(360);
await page.evaluate(() => { document.getElementById('warp').hidden = true; });
const result = page.locator('.sq-result');
await glide(...(await center(result)), 16);
await hold(3200);

await browser.close();
await writeFile(join(FRAMES, 'manifest.json'), JSON.stringify(manifest));
console.log(`${n} frames, ${(manifest.reduce((a, f) => a + f.ms, 0) / 1000).toFixed(1)}s`);
