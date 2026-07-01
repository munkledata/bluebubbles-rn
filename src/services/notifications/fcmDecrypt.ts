import * as Crypto from 'expo-crypto';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync } from 'expo-crypto';
import { fromBase64, concatBytes, utf8Encode, utf8Decode } from '@utils/bytes';

/**
 * Decrypt an FCM data-payload body encrypted by the Gator server (the `encryptComs` setting).
 * Mirrors the server's `AEAD_GCM_V1` scheme EXACTLY (see the server's fcmPayloadCrypto.ts):
 *   - AES-256-GCM via expo-crypto (native on Android)
 *   - key   = SHA-256(salt ‖ utf8(password))
 *   - frame = version(1) ‖ salt(16) ‖ iv(12) ‖ tag(16) ‖ ciphertext, base64
 *
 * Uses expo-crypto (a NATIVE module) so it only runs on-device — it cannot be exercised in
 * the Node/jest suite. The frame layout is proven by the server's round-trip test (standard
 * AES-256-GCM is interoperable), so on-device is the final verification.
 */

export const FCM_ENCRYPTION_TYPE = 'AEAD_GCM_V1';

const VERSION = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export async function decryptFcmPayload(b64Frame: string, password: string): Promise<string> {
  const buf = fromBase64(b64Frame);
  if (buf.length < 1 + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('fcm frame too short');
  if (buf[0] !== VERSION) throw new Error(`unsupported fcm frame version ${String(buf[0])}`);

  let o = 1;
  const salt = buf.subarray(o, (o += SALT_LEN));
  const iv = buf.subarray(o, (o += IV_LEN));
  const tag = buf.subarray(o, (o += TAG_LEN));
  const ciphertext = buf.subarray(o);

  // key = SHA-256(salt ‖ utf8(password)) — byte-for-byte the server's deriveKey(). Copy into a
  // fresh ArrayBuffer so the digest input is a BufferSource (TS 5.7 typed-array strictness).
  const digestInput = concatBytes(salt, utf8Encode(password));
  const digestAb = new ArrayBuffer(digestInput.byteLength);
  new Uint8Array(digestAb).set(digestInput);
  const keyBytes = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestAb));
  const key = await AESEncryptionKey.import(keyBytes);
  const sealed = AESSealedData.fromParts(iv, ciphertext, tag);
  const plaintext = await aesDecryptAsync(sealed, key, { output: 'bytes' });
  return utf8Decode(plaintext);
}
