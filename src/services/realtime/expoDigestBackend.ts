import * as Crypto from 'expo-crypto';
import type { DigestBackend } from '@core/realtime';

/** Native SHA-256 adapter injected into the platform-free incoming-event codec. */
export const expoDigestBackend: DigestBackend = {
  async sha256(input: Uint8Array): Promise<Uint8Array> {
    // Expo SDK 57's native digest bridge requires a TypedArray. Copy the exact view so a sliced
    // input cannot accidentally hash unrelated bytes from its backing buffer, then keep the
    // Uint8Array wrapper when crossing the native boundary.
    const bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
    return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
  },
};
