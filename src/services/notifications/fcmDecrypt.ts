import * as Crypto from 'expo-crypto';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync } from 'expo-crypto';
import { decodeFcmDeviceEncryptionKey, FCM_DEVICE_ENCRYPTION_TYPE } from '@core/realtime';
import { fromBase64, concatBytes, toBase64, utf8Encode, utf8Decode } from '@utils/bytes';

/**
 * Decrypt a legacy password-derived `AEAD_GCM_V1` FCM data-payload body. This is compatibility
 * code for older, never-migrated servers; current server source uses the per-device
 * `AEAD_GCM_V2_DEVICE` path below. The retained V1 wire format is:
 *   - AES-256-GCM via expo-crypto (native on Android)
 *   - key   = SHA-256(salt ‖ utf8(password))
 *   - frame = version(1) ‖ salt(16) ‖ iv(12) ‖ tag(16) ‖ ciphertext, base64
 *
 * Uses expo-crypto (a NATIVE module) so it only runs on-device — it cannot be exercised in the
 * Node/jest suite. Historical server vectors cover this legacy frame; device evidence remains
 * necessary for the native bridge.
 */

export const FCM_ENCRYPTION_TYPE = 'AEAD_GCM_V1';
export const FCM_V2_ENCRYPTION_TYPE = FCM_DEVICE_ENCRYPTION_TYPE;

const VERSION = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const V2_VERSION = 0x02;
const MAX_V2_FRAME_BYTES = 4_096;
const MAX_V2_FRAME_CHARACTERS = Math.ceil(MAX_V2_FRAME_BYTES / 3) * 4;
const MAX_EVENT_TYPE_BYTES = 256;

/** Reject ignored characters, misplaced padding, and non-zero unused padding bits. */
function decodeCanonicalBase64Frame(encoded: string): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_V2_FRAME_CHARACTERS ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new Error('malformed FCM V2 frame encoding');
  }
  const decoded = fromBase64(encoded);
  if (decoded.length > MAX_V2_FRAME_BYTES || toBase64(decoded) !== encoded) {
    throw new Error('malformed FCM V2 frame encoding');
  }
  return decoded;
}

/** Hermes-portable strict UTF-8 validation: replacement decoding cannot round-trip bad bytes. */
function decodeStrictUtf8(bytes: Uint8Array): string {
  const decoded = utf8Decode(bytes);
  const roundTrip = utf8Encode(decoded);
  if (
    roundTrip.length !== bytes.length ||
    roundTrip.some((value, index) => value !== bytes[index])
  ) {
    throw new Error('FCM V2 plaintext is not valid UTF-8');
  }
  return decoded;
}

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
  const keyBytes = new Uint8Array(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestAb),
  );
  const key = await AESEncryptionKey.import(keyBytes);
  const sealed = AESSealedData.fromParts(iv, ciphertext, tag);
  const plaintext = await aesDecryptAsync(sealed, key, { output: 'bytes' });
  return utf8Decode(plaintext);
}

/**
 * Decrypt the current server's per-device frame:
 *   version(2) | IV(12) | tag(16) | ciphertext, encoded as canonical standard base64.
 * The exact UTF-8 event type is additional authenticated data (metadata protected by the tag).
 */
export async function decryptFcmV2Payload(
  b64Frame: string,
  keyBase64Url: string,
  eventType: string,
): Promise<string> {
  const eventTypeBytes = utf8Encode(eventType);
  if (eventTypeBytes.length === 0 || eventTypeBytes.length > MAX_EVENT_TYPE_BYTES) {
    throw new Error('invalid FCM V2 event type');
  }

  const frame = decodeCanonicalBase64Frame(b64Frame);
  if (frame.length < 1 + IV_LEN + TAG_LEN) throw new Error('FCM V2 frame too short');
  if (frame[0] !== V2_VERSION) {
    throw new Error(`unsupported FCM V2 frame version ${String(frame[0])}`);
  }

  let offset = 1;
  const iv = frame.subarray(offset, (offset += IV_LEN));
  const tag = frame.subarray(offset, (offset += TAG_LEN));
  const ciphertext = frame.subarray(offset);
  const key = await AESEncryptionKey.import(decodeFcmDeviceEncryptionKey(keyBase64Url));
  const sealed = AESSealedData.fromParts(iv, ciphertext, tag);
  const plaintext = await aesDecryptAsync(sealed, key, {
    additionalData: eventTypeBytes,
    output: 'bytes',
  });
  return decodeStrictUtf8(plaintext);
}
