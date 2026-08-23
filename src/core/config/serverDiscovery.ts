/**
 * Server address normalization + failover orchestration.
 *
 * Ports `sanitizeServerAddress()` and the Firebase URL-refresh behaviour
 * (firebase_database_service.dart). The Firebase fetch itself is injected so the
 * core stays free of @react-native-firebase.
 */

/**
 * Normalize a user-entered server address into a clean origin.
 * - trims whitespace and trailing slashes
 * - prepends https:// when no scheme is given (HTTPS-first)
 *
 * NOTE: this does NOT enforce TLS — an explicitly-typed `http://` origin is preserved as-is.
 * The cleartext gate lives in `connect()` (services/index.ts), which rejects an http:// origin
 * unless the caller passes an explicit `allowCleartext` acknowledgement (so the Bearer
 * credential is never attached to an unencrypted origin by default). Use {@link isCleartext}.
 */
export function sanitizeServerAddress(input: string | null | undefined): string | null {
  if (!input) return null;
  let addr = input.trim();
  if (addr.length === 0) return null;
  addr = addr.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(addr)) {
    addr = `https://${addr}`;
  }
  try {
    const url = new URL(addr);
    // Drop any path/query/hash — we only want the origin.
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** True for plaintext HTTP origins (require explicit user opt-in to allow). */
export function isCleartext(origin: string): boolean {
  return /^http:\/\//i.test(origin);
}

/**
 * Parse an already-formed server ORIGIN without repairing it.
 *
 * This is deliberately stricter than {@link sanitizeServerAddress}, which is friendly to text the
 * user typed during setup. Realtime rotation data is untrusted and must not smuggle credentials,
 * a path, query, fragment, control character, or URL-parser backslash into an authenticated target.
 */
export function strictServerOrigin(input: string | null | undefined): string | null {
  if (!input || input !== input.trim()) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(input)) return null;
  // Accept exactly an http(s) authority and an optional single trailing slash. Checking the raw
  // form first also rejects empty `?` / `#` delimiters that URL.search/hash normalize away.
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface ServerUrlResolverDeps {
  /** Returns the current stored origin, if any. */
  getStoredOrigin: () => string | null;
  /** Fetches a fresh URL from Firebase RTDB/Firestore (config/serverUrl). */
  fetchFromFirebase: () => Promise<string | null>;
  /** Persists a newly discovered origin. */
  saveOrigin: (origin: string) => Promise<void>;
}

/**
 * Resolves the server origin, refreshing from Firebase when the stored one is
 * missing or has changed. Mirrors the connection-error → fetchNewUrl path.
 */
export class ServerUrlResolver {
  constructor(private readonly deps: ServerUrlResolverDeps) {}

  /** Force a Firebase refresh (called after a connection error). */
  async refresh(): Promise<string | null> {
    const fetched = sanitizeServerAddress(await this.deps.fetchFromFirebase());
    if (!fetched) return this.deps.getStoredOrigin();
    const current = this.deps.getStoredOrigin();
    if (fetched !== current) {
      await this.deps.saveOrigin(fetched);
    }
    return fetched;
  }
}
