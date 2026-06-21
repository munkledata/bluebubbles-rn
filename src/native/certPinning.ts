import { logger } from '@core/secure';

/** host → base64 SHA-256 SPKI hashes, e.g. `{ "srv.example.com": ["sha256/AAAA…="] }`. */
export interface CertPins {
  [host: string]: string[];
}

interface DomainOptions {
  includeSubdomains: boolean;
  publicKeyHashes: string[];
}

/** Pure: translate a host→hashes map into the library's PinningOptions (drops empty hosts). */
export function buildPinningOptions(pins: CertPins): Record<string, DomainOptions> {
  const out: Record<string, DomainOptions> = {};
  for (const [host, hashes] of Object.entries(pins)) {
    if (hashes.length > 0) out[host] = { includeSubdomains: true, publicKeyHashes: hashes };
  }
  return out;
}

let listenerAttached = false;

/**
 * Apply TLS public-key pinning for the configured hosts.
 *
 * NO-OP when no pins are configured — the native module is never touched, so a build
 * that hasn't yet linked `react-native-ssl-public-key-pinning` (pre-rebuild) stays
 * safe. Registers a one-time mismatch listener that logs a possible-MITM warning (the
 * native layer blocks the connection regardless).
 *
 * The hashes must be SUPPLIED (manual pin) — the library validates known pins but
 * cannot observe a cert, so true pin-on-first-connect TOFU isn't available here.
 * Get a hash with: `openssl s_client -connect host:443 | openssl x509 -pubkey -noout |
 * openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64`.
 */
export async function applyCertPinning(pins: CertPins): Promise<boolean> {
  const options = buildPinningOptions(pins);
  if (Object.keys(options).length === 0) return false;
  try {
    const ssl = await import('react-native-ssl-public-key-pinning');
    if (!ssl.isSslPinningAvailable()) return false;
    await ssl.initializeSslPinning(options);
    if (!listenerAttached) {
      ssl.addSslPinningErrorListener((error) => {
        logger.warn('[security] TLS pin mismatch — possible MITM; connection blocked', error);
      });
      listenerAttached = true;
    }
    return true;
  } catch (e) {
    logger.warn('[security] cert pinning unavailable (not linked / init failed)', e);
    return false;
  }
}
