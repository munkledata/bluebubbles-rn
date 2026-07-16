/**
 * @mention range computation for the composer. The composer records each picked mention as a
 * `{ address, label }` (label = the `@Name` text inserted). On send we resolve each pick to its
 * span in the FINAL text — the user may have edited around the mentions after inserting them, so
 * ranges are computed from the text at send time, not tracked live.
 */

export interface MentionPick {
  /** The mentioned participant's handle address. */
  address: string;
  /** The exact text inserted for the mention, e.g. "@Alice". */
  label: string;
}

export interface MentionRange {
  start: number;
  length: number;
  address: string;
}

/**
 * Resolve picked mentions to `{ start, length, address }` spans in `text`. Each pick is matched to
 * the first occurrence of its label that doesn't overlap an already-assigned span (so two mentions
 * of the same person, or out-of-order insertions, each map to a distinct occurrence). A pick whose
 * label no longer appears (the user deleted/edited it) is dropped. Result is sorted by `start`.
 */
export function computeMentionRanges(text: string, picks: MentionPick[]): MentionRange[] {
  const out: MentionRange[] = [];
  for (const pick of picks) {
    if (!pick.label) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(pick.label, from);
      if (idx < 0) break;
      const end = idx + pick.label.length;
      const overlaps = out.some((m) => idx < m.start + m.length && end > m.start);
      if (!overlaps) {
        out.push({ start: idx, length: pick.label.length, address: pick.address });
        break;
      }
      from = idx + 1;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The active `@query` being typed at `cursor`, or null. An `@` starts a mention only at the string
 * start or after whitespace (so an email's `@` doesn't trigger it); the query runs from just after
 * the `@` to the cursor and must contain no whitespace.
 */
export function activeMentionQuery(
  text: string,
  cursor: number,
): { atIndex: number; query: string } | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const c = text.charAt(i);
    if (c === '@') {
      if (i === 0 || /\s/.test(text.charAt(i - 1))) {
        return { atIndex: i, query: text.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(c)) return null;
  }
  return null;
}
