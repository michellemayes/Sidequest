import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dist/cdp -> dist -> project root. The overlay ships as plain JS, unbuilt,
// so it lives outside src/ and is read at inject time.
const OVERLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "overlay");

/**
 * The overlay's parts, in the order they run. They share one scope, so a
 * part may call a function from any other but may only read a top-level
 * const or let declared in an earlier one.
 */
const PARTS = [
  "config.js",
  "layer.js",
  "transport.js",
  "slack.js",
  "menu.js",
  "repos.js",
  "start.js",
  "toast.js",
  "results.js",
  "inline.js",
  "replies.js",
  "sync.js",
  "channel.js",
  "sessionsPanel.js",
  "placement.js",
  "triggers.js",
];

const read = (name: string): string => readFileSync(join(OVERLAY_DIR, name), "utf8");

/**
 * The overlay as one script for a page, read from disk on every call so that
 * editing client/overlay needs a Slack reload rather than a daemon restart.
 * It expects window.__SIDEQUEST_CONFIG to be set before it runs.
 */
export function overlaySource(): string {
  const styles = {
    tokens: read("tokens.css"),
    overlay: read("overlay.css"),
    inline: read("inline.css"),
  };
  return [
    "(() => {",
    "if (window.__SIDEQUEST__) return;",
    // The daemon installs this in every frame of the window, iframes included
    // (embeds, Slack's own sandboxes). The overlay belongs to the app's top
    // frame only; anywhere else it would draw a second layer, or fail to find
    // any messages and keep looking.
    "if (window.top !== window) return;",
    "window.__SIDEQUEST__ = true;",
    `const STYLES = ${JSON.stringify(styles)};`,
    ...PARTS.map((name) => `// ---- ${name}\n${read(name)}`),
    "})();",
  ].join("\n");
}
