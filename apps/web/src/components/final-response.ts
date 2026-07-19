const markdownBlock = /^(?: {0,3}#{1,6}[ \t]+| {0,3}(?:[-+*]|\d+[.)])[ \t]+| {0,3}>[ \t]+| {0,3}(?:`{3,}|~{3,})[^\n]*)/m;
const markdownTable = /^[^\n|]*\|[^\n|]+(?:\|[^\n]*)?\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?(?:[ \t]*\|[ \t]*:?-{3,}:?)*[ \t]*\|?[ \t]*$/m;
const markdownInline = /(?:`[^`\n]+`|\*\*\S(?:[^\n]*?\S)?\*\*|__\S(?:[^\n]*?\S)?__|~~\S(?:[^\n]*?\S)?~~|\[[^\]\n]+\]\((?!\s)[^)\n]+\))/;

export function looksLikeMarkdown(content: string): boolean {
  const candidate = content.trim();
  if (!candidate) return false;
  return markdownBlock.test(candidate) || markdownTable.test(candidate) || markdownInline.test(candidate);
}
