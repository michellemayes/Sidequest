/** chat.postMessage reads &, < and > as markup; text escaped here posts as written. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
