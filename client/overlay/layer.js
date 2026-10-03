let host = null;
let ui = null;
let launchBtn = null;
let channelBtn = null;
let menuEl = null;
let menuRow = null;
let menuSig = '';
let menuIndex = -1;
let panelEl = null;
let sessionsEl = null;
/** Keys for whichever text box holds the keyboard: the path box, the Ask box or the reply box. */
let boxKeys = null;
let toastEl = null;
let toastTimer = 0;

/** Everything drawn lives in here, so losing the host means losing all of it. */
function resetLayer() {
  ui = null;
  launchBtn = null;
  channelBtn = null;
  menuEl = null;
  menuRow = null;
  menuSig = '';
  menuIndex = -1;
  panelEl = null;
  sessionsEl = null;
  boxKeys = null;
  toastEl = null;
  themeSig = '';
}

function ensureLayer() {
  if (host && !host.isConnected) {
    host = null;
    resetLayer();
  }
  if (host && ui) return true;

  const parent = document.body || document.documentElement;
  if (!parent) return false;

  host = document.createElement('div');
  host.id = LAYER_ID;
  // Zero-sized, inert and last: the layer occupies nothing Slack lays out,
  // and takes part in no hit test of Slack's.
  host.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
    'margin:0', 'padding:0', 'border:0',
    'overflow:visible', 'pointer-events:none', 'z-index:2147483000',
  ].join(';');
  ui = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;
  launchBtn = buildLaunchButton();
  channelBtn = buildChannelButton();
  ui.append(style, launchBtn, channelBtn);

  parent.appendChild(host);
  // A handle for the tests and for anyone poking at the overlay from Slack's
  // devtools console.
  window.__SIDEQUEST_UI__ = ui;
  return true;
}

/*
 * The host is transparent, so a background is the one thing the overlay
 * cannot inherit from Slack — and a hardcoded near-white one is unreadable
 * on a dark workspace under Slack's own light text. So the nearest opaque
 * background behind the message list is read off Slack's DOM and handed to
 * the stylesheet as --sq-bg. Read, as ever, never written.
 */
const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/;

function parseColor(value) {
  const m = RGB.exec(String(value || ''));
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
}

const isLight = (color) => color
  ? (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 > 0.6
  : false;

function opaqueBackground(start) {
  let node = start;
  for (let hops = 0; node && hops < 30; hops += 1) {
    const color = parseColor(getComputedStyle(node).backgroundColor);
    if (color && color.a > 0.9) return `rgb(${color.r}, ${color.g}, ${color.b})`;
    node = node.parentElement;
  }
  return '';
}

let themeSig = '';

function refreshTheme() {
  const anchor = document.querySelector(SEL.content)
    || document.querySelector(SEL.channel)
    || document.body;
  const text = getComputedStyle(host).color;
  // Nothing opaque to be found: light text means a dark workspace, so the
  // guess at least lands on the right side of legible.
  const bg = opaqueBackground(anchor) || (isLight(parseColor(text)) ? '#1a1d21' : '#ffffff');
  const sig = `${bg}|${text}`;
  if (sig === themeSig) return;
  themeSig = sig;
  host.style.setProperty('--sq-bg', bg);
}

const show = (el) => el.classList.remove('sq-off');
const hide = (el) => el.classList.add('sq-off');

/** Viewport coordinates, kept on screen. Measured after the element is shown. */
function placeAt(el, left, top) {
  const maxLeft = Math.max(4, window.innerWidth - el.offsetWidth - 4);
  const maxTop = Math.max(4, window.innerHeight - el.offsetHeight - 4);
  el.style.left = `${Math.round(Math.min(Math.max(4, left), maxLeft))}px`;
  el.style.top = `${Math.round(Math.min(Math.max(4, top), maxTop))}px`;
}
