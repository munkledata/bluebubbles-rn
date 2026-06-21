/**
 * Internal helpers shared across the repository submodules. Not re-exported from
 * the barrel (`./index.ts`) — these were module-private in the original
 * `repositories.ts` and stay private here.
 */

/** Keep the last item per key (server batches can repeat handles/chats). */
export function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(key(it), it);
  return [...map.values()];
}

/** Split a list into fixed-size chunks (for bounded SQL `IN (...)` lists). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sanitize a user query into a safe FTS5 prefix match (quote each token). */
export function toFtsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
