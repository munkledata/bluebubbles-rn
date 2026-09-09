import { sanitizeServerAddress } from '@core/config';

export interface ParsedSetupQr {
  password: string;
  origin: string;
}

export type SetupQrParseErrorCode =
  'empty' | 'invalid-json' | 'invalid-shape' | 'missing-credentials';

/** Stable parser classification for callers that need to choose presentation copy. */
export class SetupQrParseError extends Error {
  override readonly name = 'SetupQrParseError';

  constructor(readonly code: SetupQrParseErrorCode) {
    super('setup-qr-parse-error');
  }
}

/** Stable build failure for callers that need to choose presentation copy. */
export class SetupQrBuildError extends Error {
  override readonly name = 'SetupQrBuildError';
  readonly code = 'missing-credentials';

  constructor() {
    super('setup-qr-build-error');
  }
}

/**
 * Parse a Gator setup QR code.
 *
 * The server encodes a JSON array `[password, serverURL, ...]` (matching the
 * Flutter app's `jsonDecode(response)` in server_credentials.dart). We validate
 * length >= 2, then sanitize the URL into a clean origin.
 *
 * Throws a typed, non-presentational code on malformed input; callers own user-facing copy.
 */
export function parseSetupQr(raw: string | null | undefined): ParsedSetupQr {
  if (!raw || raw.trim().length === 0) {
    throw new SetupQrParseError('empty');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new SetupQrParseError('invalid-json');
  }

  if (!Array.isArray(decoded) || decoded.length < 2) {
    throw new SetupQrParseError('invalid-shape');
  }

  const password = typeof decoded[0] === 'string' ? decoded[0] : '';
  const origin = sanitizeServerAddress(typeof decoded[1] === 'string' ? decoded[1] : null);

  if (!password || !origin) {
    throw new SetupQrParseError('missing-credentials');
  }

  return { password, origin };
}

/**
 * Build the setup QR payload for DISPLAY on this device, so another device can
 * scan it and pair. Emits the exact shape `parseSetupQr` (and the Flutter app)
 * accept: a JSON array `[password, serverURL]`.
 *
 * SECURITY: the returned string contains the server password. Never log it and
 * only render it behind an explicit user reveal (see PairingQr).
 *
 * Throws when either credential is missing/blank — callers should treat that as
 * "no QR available", not render an empty code.
 */
export function buildSetupQr(origin: string, password: string): string {
  const cleanOrigin = sanitizeServerAddress(origin);
  if (!cleanOrigin || !password) {
    throw new SetupQrBuildError();
  }
  return JSON.stringify([password, cleanOrigin]);
}
