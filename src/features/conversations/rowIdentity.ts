/**
 * Referential-identity preserver for reactive list re-queries.
 *
 * Every reactive DB flush re-runs the list query and rebuilds every row object, so a
 * memoized row component (MessageRow, ConversationTile) sees a "new" `msg`/`chat` prop on
 * every flush and its React.memo is defeated — the same identity churn that caused the
 * ImageAttachment re-download storm (see src/ui/attachments/ImageAttachment.tsx).
 *
 * `createRowIdentityCache` returns a reconcile function: feed it the freshly-mapped rows
 * and it returns the PREVIOUS object for any row whose content fingerprint is unchanged,
 * so unchanged rows keep their identity across re-queries. The fingerprint defaults to
 * `JSON.stringify(row)` — deliberately over-inclusive (every column, nested attachments/
 * reactions/previews), because a missed mutable field would mean stale UI. The cache is
 * rebuilt each pass, so rows that left the window don't leak.
 */
export function createRowIdentityCache<T>(
  keyOf: (row: T) => string,
  fingerprintOf: (row: T) => string = (row) => JSON.stringify(row),
): (rows: T[]) => T[] {
  let cache = new Map<string, { fp: string; row: T }>();
  let lastRows: T[] | null = null;

  return (rows: T[]): T[] => {
    const prevRows = lastRows;
    const next = new Map<string, { fp: string; row: T }>();
    let allKept = prevRows !== null && prevRows.length === rows.length;
    const out = rows.map((row, i) => {
      const key = keyOf(row);
      const fp = fingerprintOf(row);
      const prev = cache.get(key);
      const kept = prev && prev.fp === fp ? prev.row : row;
      next.set(key, { fp, row: kept });
      if (allKept && prevRows?.[i] !== kept) allKept = false;
      return kept;
    });
    cache = next;
    // Nothing changed at all → keep the ARRAY identity too (downstream useMemos stay stable).
    const result = allKept && prevRows !== null ? prevRows : out;
    lastRows = result;
    return result;
  };
}
