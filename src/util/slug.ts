/**
 * Turn arbitrary message text into a short, git-safe branch fragment.
 *
 * git check-ref-format forbids a lot: whitespace, `~^:?*[\`, leading/trailing
 * dots and slashes, `@{`, consecutive dots, and a trailing `.lock`. Reducing to
 * [a-z0-9-] sidesteps all of it.
 */
export function slugify(input: string, maxLength = 40): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= maxLength) return slug;

  // Cut on a word boundary when there is one reasonably close to the limit.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  const trimmed = lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut;
  return trimmed.replace(/-+$/g, "");
}

/**
 * Strip Slack's markup so the branch name and prompt read as plain prose:
 * <@U123|name> mentions, <#C123|chan> channel links, <http://x|label> links,
 * and &amp;-style entities.
 */
export function stripSlackMarkup(text: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${label || id}`)
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, label?: string) => label || "@group")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^|>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A compact, sortable timestamp fragment: 20260909-1432. */
export function timeFragment(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}
