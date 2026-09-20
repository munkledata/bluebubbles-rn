/** Keep search text identical between the live inbox matcher and its future candidate index. */
export function foldInboxSearchText(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

function bigramAt(text: string, offset: number): number {
  return text.charCodeAt(offset) * 65_536 + text.charCodeAt(offset + 1);
}

/**
 * JavaScript `includes` compares UTF-16 units, so postings must use adjacent units too. A
 * code-point index could miss a query beginning inside an astral character or containing a lone
 * surrogate. The numeric encoding also avoids SQLite text handling of malformed UTF-16 and NUL.
 */
export function uniqueInboxSearchBigrams(foldedText: string): number[] {
  const grams = new Set<number>();
  for (let offset = 0; offset + 1 < foldedText.length; offset += 1) {
    grams.add(bigramAt(foldedText, offset));
  }
  return [...grams];
}

export function firstInboxSearchBigram(foldedQuery: string): number {
  if (foldedQuery.length < 2) throw new RangeError('Inbox search needs two UTF-16 units.');
  return bigramAt(foldedQuery, 0);
}
