import { sanitizeServerAddress } from '@core/config';

export interface ParsedSetupQr {
  password: string;
  origin: string;
}

/**
 * Parse a BlueBubbles setup QR code.
 *
 * The server encodes a JSON array `[password, serverURL, ...]` (matching the
 * Flutter app's `jsonDecode(response)` in server_credentials.dart). We validate
 * length >= 2, then sanitize the URL into a clean origin.
 *
 * Throws with a user-facing message on any malformed input.
 */
export function parseSetupQr(raw: string | null | undefined): ParsedSetupQr {
  if (!raw || raw.trim().length === 0) {
    throw new Error('No data was scanned, please try again.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('Scanned code was not a valid BlueBubbles QR code.');
  }

  if (!Array.isArray(decoded) || decoded.length < 2) {
    throw new Error('Invalid data scanned!');
  }

  const password = typeof decoded[0] === 'string' ? decoded[0] : '';
  const origin = sanitizeServerAddress(typeof decoded[1] === 'string' ? decoded[1] : null);

  if (!password || !origin) {
    throw new Error('Could not detect server URL and password!');
  }

  return { password, origin };
}
