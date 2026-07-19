export interface ActiveFileMention {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
}

export interface FileMentionReplacement {
  value: string;
  caret: number;
}

function validTrigger(value: string, start: number): boolean {
  return start === 0 || /[\s([{]/u.test(value[start - 1] ?? "");
}

function plainEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && !/[\s)\]}]/u.test(value[end] ?? "")) end += 1;
  return end;
}

export function activeFileMention(value: string, caret: number): ActiveFileMention | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  let searchFrom = caret - 1;
  while (searchFrom >= 0) {
    const start = value.lastIndexOf("@", searchFrom);
    if (start < 0) return null;
    searchFrom = start - 1;
    if (!validTrigger(value, start)) continue;
    const quoted = value[start + 1] === '"';
    const contentStart = start + (quoted ? 2 : 1);
    if (caret < contentStart) continue;
    if (quoted) {
      const lineEnd = value.indexOf("\n", contentStart);
      const closingQuote = value.indexOf('"', contentStart);
      const hasClosingQuote = closingQuote >= 0 && (lineEnd < 0 || closingQuote < lineEnd);
      const end = hasClosingQuote ? closingQuote + 1 : lineEnd >= 0 ? lineEnd : value.length;
      const queryEnd = hasClosingQuote && caret === closingQuote + 1 ? closingQuote : caret;
      if (caret > end || queryEnd < contentStart) continue;
      return { start, end, query: value.slice(contentStart, queryEnd), quoted: true };
    }
    const end = plainEnd(value, contentStart);
    if (caret > end) continue;
    return { start, end, query: value.slice(contentStart, caret), quoted: false };
  }
  return null;
}

export function replaceFileMention(
  value: string,
  mention: ActiveFileMention,
  path: string,
): FileMentionReplacement {
  const inserted = path.includes(" ") ? `@"${path}"` : `@${path}`;
  const suffix = value.slice(mention.end);
  const usesExistingSpace = suffix.startsWith(" ");
  const separator = usesExistingSpace ? "" : " ";
  return {
    value: `${value.slice(0, mention.start)}${inserted}${separator}${suffix}`,
    caret: mention.start + inserted.length + (usesExistingSpace ? 1 : separator.length),
  };
}
