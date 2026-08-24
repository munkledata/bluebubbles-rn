/**
 * Server address normalization and strict realtime-rotation classification.
 *
 * Setup input is repaired for convenience, while server-supplied rotation input is
 * deliberately fail-closed and cannot trigger persistence by itself.
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

/** Bound attacker-controlled rotation text before it is copied or canonicalized. */
export const MAX_SERVER_ORIGIN_INPUT_LENGTH = 2_048;

/**
 * Parse an already-formed server ORIGIN without repairing it.
 *
 * This is deliberately stricter than {@link sanitizeServerAddress}, which is friendly to text the
 * user typed during setup. Realtime rotation data is untrusted and must not smuggle credentials,
 * a path, query, fragment, control character, or URL-parser backslash into an authenticated target.
 */
export function strictServerOrigin(input: string | null | undefined): string | null {
  if (!input || input !== input.trim()) return null;
  if (input.length > MAX_SERVER_ORIGIN_INPUT_LENGTH) return null;
  // Reject the raw user-info delimiter even when both parsed fields are empty (`https://@host`).
  if (/[\\\u0000-\u001f\u007f]/.test(input) || input.includes('@')) return null;
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

export type ServerRotationClassification =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'same-origin'; readonly origin: string }
  | {
      readonly kind: 'candidate';
      readonly currentOrigin: string;
      readonly candidateOrigin: string;
      /** A current cleartext session needs a separate, explicit acknowledgement for its new host. */
      readonly requiresCleartextApproval: boolean;
    }
  | {
      readonly kind: 'downgrade';
      readonly currentOrigin: string;
      readonly candidateOrigin: string;
    };

/**
 * Classify one untrusted `new-server` value without repairing it or performing any effect.
 *
 * A secure session can never rotate itself to plaintext. A user who truly intends that downgrade
 * must leave the session and use setup's explicit cleartext path. An already-approved HTTP session
 * may offer another HTTP origin, but the foreground prompt must ask for cleartext consent again.
 */
export function classifyServerRotation(
  currentInput: string | null | undefined,
  candidateInput: string | null | undefined,
): ServerRotationClassification {
  const currentOrigin = strictServerOrigin(currentInput);
  const candidateOrigin = strictServerOrigin(candidateInput);
  if (!currentOrigin || !candidateOrigin) return { kind: 'invalid' };
  if (candidateOrigin === currentOrigin) return { kind: 'same-origin', origin: currentOrigin };

  const currentCleartext = isCleartext(currentOrigin);
  const candidateCleartext = isCleartext(candidateOrigin);
  if (!currentCleartext && candidateCleartext) {
    return { kind: 'downgrade', currentOrigin, candidateOrigin };
  }
  return {
    kind: 'candidate',
    currentOrigin,
    candidateOrigin,
    requiresCleartextApproval: candidateCleartext,
  };
}
