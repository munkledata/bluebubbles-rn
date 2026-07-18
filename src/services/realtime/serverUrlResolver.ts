/**
 * Server-URL rediscovery for the socket reconnect escalation (Phase 1.1).
 *
 * When socket.io exhausts its capped retries, SocketService calls its `refreshUrl` hook
 * to ask "did the server move while I was down?". The answer can already be sitting in
 * the session store: a `new-server` event delivered over FCM (alive while the socket is
 * dead) runs `applyNewServerUrl`, which persists + stores the rotated tunnel URL — the
 * socket just never re-reads it. This resolver closes that loop.
 *
 * Kept as a plain injected-source function (no React, no store imports) so a future
 * Firebase-RTDB lookup can slot in as just another {@link ServerUrlSource}. Sources are
 * consulted in order; the first one holding a valid http(s) URL that DIFFERS from the
 * URL the socket is currently trying wins. Returns null when nothing new is known.
 */

/** A place the current server URL can be read from (session store, Firebase RTDB, …). */
export interface ServerUrlSource {
  /** Short name for logging/debugging. */
  name: string;
  /** Return the source's current server URL, or null/undefined when unknown. */
  get(): Promise<string | null | undefined> | string | null | undefined;
}

/**
 * Validate + normalize a candidate server URL: trimmed, non-empty, http(s)-schemed.
 * Anything else → null (never hand the socket a bogus origin). Same scheme rule as
 * `applyNewServerUrl` — auth never targets a non-http(s) origin, and the password stays
 * in the header/auth payload, never the URL.
 */
export function normalizeServerUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return url;
}

/**
 * Build a `refreshUrl` hook for {@link SocketAuthOptions}: given the URL the socket is
 * currently trying, return the first source's valid URL that differs — else null
 * ("nothing new; retry the same origin"). A throwing source is skipped, never fatal.
 */
export function createServerUrlResolver(
  sources: readonly ServerUrlSource[],
): (currentUrl: string) => Promise<string | null> {
  return async (currentUrl: string): Promise<string | null> => {
    for (const source of sources) {
      let candidate: string | null = null;
      try {
        candidate = normalizeServerUrl(await source.get());
      } catch {
        continue; // a broken source must not kill the escalation ladder
      }
      if (candidate && candidate !== currentUrl) return candidate;
    }
    return null;
  };
}
