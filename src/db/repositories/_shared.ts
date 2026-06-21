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

/** Sanitize a user query into a safe FTS5 prefix match (quote each token). */
export function toFtsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
