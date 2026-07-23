/**
 * Decide HOW to open a `/chat/…` deep-link relative to where the user already is.
 *
 * The app keeps ONE navigation stack with the Messages list at its base, so opening a thread
 * should keep the stack at `[Messages, thread]` (Back → inbox). But there's a second concern:
 * a notification tapped while ALREADY viewing that exact thread must NOT tear the screen down
 * and rebuild it. `router.replace('/chat/<same-guid>')` mounts a FRESH screen instance (a new
 * route key), so the chat visibly reloads — spinner, re-scroll, lost draft/scroll position.
 *
 * The three outcomes:
 *   - not currently in a chat            → 'push'    (inbox/search/etc. → thread)
 *   - already on the SAME plain thread   → 'none'    (do nothing — no reload)
 *   - on a DIFFERENT thread              → 'replace' (swap, so Back still → Messages)
 *
 * A reminder ANCHOR (`?focus=…`) or a Direct-Share (`?share=1`) target always (re)navigates,
 * even into the open chat: the reminder must jump to its old message, and the share must
 * re-stage its files. Only a PLAIN message tap into the thread already on screen is a no-op —
 * which is exactly the case that used to reload.
 *
 * Encoding-agnostic: `chatDeepLink` URL-encodes the guid, while `usePathname()` reports it
 * decoded — so we decode BOTH sides before comparing (guids contain `;` and `+`).
 */
export type ChatNavAction = 'push' | 'replace' | 'none';

/**
 * @param currentPathname the current route path WITHOUT query (expo-router `usePathname()`)
 * @param targetPath      a `/chat/<encoded-guid>[?focus=…&focusDate=…][?share=1]` deep-link
 */
export function resolveChatNavigation(currentPathname: string, targetPath: string): ChatNavAction {
  // Not inside a thread → a plain push keeps the stack at [Messages, thread].
  if (!currentPathname.startsWith('/chat/')) return 'push';
  const current = parseChatPath(currentPathname);
  const target = parseChatPath(targetPath);
  // A malformed/non-chat target while in a chat shouldn't happen (all callers pass /chat/…);
  // navigate rather than silently swallow it.
  if (!current || !target) return 'replace';
  // A reminder anchor or a Direct Share must always (re)navigate, even into the open chat.
  if (target.focus || target.share) return 'replace';
  // Same plain thread → we're already here; do nothing. Different thread → swap it.
  return target.guid === current.guid ? 'none' : 'replace';
}

interface ParsedChatPath {
  /** The chat guid, URL-decoded. */
  guid: string;
  /** The anchored-message guid from `?focus=…`, decoded (`''` when absent). */
  focus: string;
  /** Whether the link carries `?share=1` (a Direct Share into the chat). */
  share: boolean;
}

/** Parse a `/chat/<encoded-guid>?focus=…&share=…` deep-link into its decoded parts. */
function parseChatPath(path: string): ParsedChatPath | null {
  if (!path.startsWith('/chat/')) return null;
  const rest = path.slice('/chat/'.length);
  const q = rest.indexOf('?');
  const encGuid = q === -1 ? rest : rest.slice(0, q);
  if (!encGuid) return null;
  const query = q === -1 ? '' : rest.slice(q + 1);
  const params = parseQuery(query);
  return {
    guid: safeDecode(encGuid),
    focus: params.focus ?? '',
    share: params.share === '1',
  };
}

/**
 * Minimal `key=value&…` query parser (decoding each part). Hand-rolled rather than
 * `URLSearchParams` because RN's polyfill is unreliable and this runs on the notification path.
 */
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    out[safeDecode(key)] = safeDecode(val);
  }
  return out;
}

/** decodeURIComponent that never throws (a stray `%` in a decoded pathname would). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
