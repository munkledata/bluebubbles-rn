import { applyCertPinning, type CertPins } from '@native/certPinning';
import { vault } from './clients';

// ── TLS certificate pinning ──────────────────────────────────────────────────
// Pins live in the vault (host → SPKI hashes) so they apply before any network call.
// Empty by default (no-op); populate via setCertPins once you have the server's hash.

/** Read the stored TLS pins (host → base64 SHA-256 SPKI hashes). */
export async function getCertPins(): Promise<CertPins> {
  const raw = await vault.get('certPins');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CertPins;
  } catch {
    return {};
  }
}

/** Persist + immediately apply TLS pins. Pass `{}` to clear (then a rebuild to drop native pinning). */
export async function setCertPins(pins: CertPins): Promise<void> {
  await vault.set('certPins', JSON.stringify(pins));
  await applyCertPinning(pins);
}

/** Apply the stored pins (called at boot). No-op when none are configured. */
export async function applyStoredCertPins(): Promise<void> {
  await applyCertPinning(await getCertPins());
}
