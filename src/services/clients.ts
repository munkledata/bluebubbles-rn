import { HttpClient } from '@core/api';
import { SecretBox } from '@core/crypto';
import { ExpoSecureVault } from '@native/secureVault';
import { sessionAccessors } from '@state/sessionStore';

/**
 * Composition root.
 *
 * Instantiates the app's services once and wires them together explicitly
 * (replacing GetX's global service locator). The store-bound HttpClient reads
 * the active origin/password synchronously from the session store, so its auth
 * header is always current — and never appears in a URL.
 */

export const vault = new ExpoSecureVault();

/** The primary client, bound to the connected session. */
export const http = new HttpClient({
  getOrigin: sessionAccessors.getOrigin,
  getPassword: sessionAccessors.getPassword,
});

/** A throwaway client for validating candidate credentials during setup. */
export function candidateClient(origin: string, password: string): HttpClient {
  return new HttpClient({ getOrigin: () => origin, getPassword: () => password });
}

// ── Authenticated encryption (XChaCha20-Poly1305 + Argon2id) ───────────────────
// The native libsodium backend is pulled in via a dynamic import so it is evaluated
// only on first crypto use — never at startup — keeping a JS bundle safe on a build
// that hasn't yet linked the native module (the lazy native-module import pattern).
let secretBoxPromise: Promise<SecretBox> | null = null;

/**
 * The app's authenticated-encryption box, backed by native libsodium. Lazily
 * constructed once. Use for at-rest secret wrapping / server payloads (see SecretBox).
 * Requires a native build that links `react-native-libsodium` (Phase 0 rebuild).
 */
export function getSecretBox(): Promise<SecretBox> {
  secretBoxPromise ??= (async (): Promise<SecretBox> => {
    const { createNativeCryptoBackend } = await import('@native/crypto');
    return new SecretBox(await createNativeCryptoBackend());
  })();
  return secretBoxPromise;
}

/**
 * Dev-only crypto round-trip self-test (Phase 0 device proof). Seals then opens a
 * known string and asserts equality — exercises the real native AEAD + KDF on device.
 * NOT run at startup (it would load the native module); invoke it manually after the
 * libsodium-linked rebuild, e.g. from a dev button.
 */
export async function runCryptoSelfTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const box = await getSecretBox();
    const secret = 'gator-crypto-self-test-✅';
    const sealed = await box.seal(secret, 'correct horse battery staple');
    const opened = await box.open(sealed, 'correct horse battery staple');
    let tamperRejected = false;
    try {
      await box.open(sealed, 'wrong passphrase');
    } catch {
      tamperRejected = true; // authenticated decryption must reject a bad key
    }
    const ok = opened === secret && tamperRejected;
    return { ok, detail: ok ? 'round-trip + tamper-reject OK' : 'mismatch or tamper not rejected' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'self-test threw' };
  }
}
