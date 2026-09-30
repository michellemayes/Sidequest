// Records the README demo: the real client/inject.js running over page.html,
// a Slack-shaped mock channel. The daemon is stubbed to answer with a branch
// name, so no worktree or Warp tab is involved.
//
//   npm i --no-save playwright-core && node docs/demo/capture.mjs
//   python3 docs/demo/make_gif.py      # frames/ -> demo.gif (needs Pillow)
import { chromium } from 'playwright-core';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(HERE, 'frames');
await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1120, height: 400 }, deviceScaleFactor: 2 });
await page.goto('file://' + join(HERE, 'page.html'));

await page.evaluate(() => {
  window.__SIDEQUEST_CONFIG = {
    prompts: [
      { key: 'investigate', label: 'Investigate' },
      { key: 'fix', label: 'Fix' },
      { key: 'review', label: 'Review' },
    ],
    linkedChannels: ['bugs-storefront'],
    repoLabels: { 'bugs-storefront': 'storefront' },
    agentLabel: 'Claude Code',
  };
  window.__sidequestAsk = (json) => {
    const req = JSON.parse(json);
    const reply = { id: req.id, ok: true, branch: 'fix/checkout-total-is-wrong-20260930-1426' };
    setTimeout(() => window.__sidequestResult(JSON.stringify(reply)), 700);
  };
  // Headless Chromium draws no pointer; draw one above everything.
  const cursor = document.createElement('div');
  cursor.innerHTML = '<svg width="18" height="26" viewBox="0 0 18 26"><path d="M1 1v20l5-5 4 9 3-1.4-4-8.6h7z" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>';
  Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none' });
  document.documentElement.appendChild(cursor);
  addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
});
await page.addScriptTag({ content: await readFile(join(HERE, '../../client/inject.js'), 'utf8') });

let n = 0;
let pos = { x: 820, y: 360 };
const frame = () => page.screenshot({ path: join(FRAMES, `${String(n++).padStart(3, '0')}.png`) });
const hold = async (count) => { for (let i = 0; i < count; i++) { await page.waitForTimeout(60); await frame(); } };
const glide = async (x, y, steps = 12) => {
  const from = pos;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await frame();
  }
  pos = { x, y };
};
const center = async (locator) => {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

await page.mouse.move(pos.x, pos.y);
await hold(8);
await glide(600, 150, 14);            // onto Priya's message
await hold(6);
const launch = page.locator('.sq-launch');
await launch.waitFor({ state: 'visible' });
await glide(...(await center(launch)), 10);
await hold(4);
await page.mouse.down(); await page.mouse.up();
await hold(8);
const fix = page.locator('.sq-menu-prompt', { hasText: 'Fix' });
await glide(...(await center(fix)), 8);
await hold(6);
await page.screenshot({ path: join(HERE, 'menu.png') });
await page.mouse.down(); await page.mouse.up();
await hold(4);
await page.locator('.sq-result').waitFor();
await glide(820, 360, 10);
await hold(30);

await browser.close();
console.log(`${n} frames`);
