import { AESEncryptionKey, AESSealedData, aesDecryptAsync } from 'expo-crypto';
import {
  decodeFcmDeviceEncryptionKey,
  decodeFcmPushEnvelopeIdentityV3,
  FCM_DEVICE_ENCRYPTION_TYPE,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  type FcmPushEnvelopeIdentityV3,
} from '@core/realtime';
import { fromBase64, toBase64, utf8Encode, utf8Decode } from '@utils/bytes';

export const FCM_V2_ENCRYPTION_TYPE = FCM_DEVICE_ENCRYPTION_TYPE;
export const FCM_V3_ENCRYPTION_TYPE = FCM_PUSH_ENCRYPTION_TYPE_V3;

const IV_LEN = 12;
const TAG_LEN = 16;
const V2_VERSION = 0x02;
const V3_VERSION = 0x03;
const MAX_V2_FRAME_BYTES = 4_096;
const MAX_V2_FRAME_CHARACTERS = Math.ceil(MAX_V2_FRAME_BYTES / 3) * 4;
const MAX_EVENT_TYPE_BYTES = 256;

/** Reject ignored characters, misplaced padding, and non-zero unused padding bits. */
function decodeCanonicalBase64Frame(encoded: string, scheme: 'V2' | 'V3'): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_V2_FRAME_CHARACTERS ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new Error(`malformed FCM ${scheme} frame encoding`);
  }
  const decoded = fromBase64(encoded);
  if (decoded.length > MAX_V2_FRAME_BYTES || toBase64(decoded) !== encoded) {
    throw new Error(`malformed FCM ${scheme} frame encoding`);
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

  const frame = decodeCanonicalBase64Frame(b64Frame, 'V2');
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

export interface DecryptedFcmV3Payload {
  readonly plaintext: string;
  readonly identity: FcmPushEnvelopeIdentityV3;
}

/**
 * Decrypt the identity-bound V3 frame:
 *   version(3) | AAD length (u16 BE) | canonical identity AAD | IV(12) | tag(16) | ciphertext.
 * The plaintext event is accepted only when its authenticated identity matches the outer route.
 */
export async function decryptFcmV3Payload(
  b64Frame: string,
  keyBase64Url: string,
  outerEventType: string,
): Promise<DecryptedFcmV3Payload> {
  const frame = decodeCanonicalBase64Frame(b64Frame, 'V3');
  if (frame.length < 1 + 2 + 1 + IV_LEN + TAG_LEN + 1) {
    throw new Error('FCM V3 frame too short');
  }
  if (frame[0] !== V3_VERSION) {
    throw new Error(`unsupported FCM V3 frame version ${String(frame[0])}`);
  }

  const aadLength = (frame[1]! << 8) | frame[2]!;
  const aadStart = 3;
  const ivStart = aadStart + aadLength;
  const tagStart = ivStart + IV_LEN;
  const ciphertextStart = tagStart + TAG_LEN;
  if (aadLength === 0 || ciphertextStart >= frame.length) {
    throw new Error('malformed FCM V3 frame lengths');
  }

  const aad = frame.subarray(aadStart, ivStart);
  const identity = decodeFcmPushEnvelopeIdentityV3(aad);
  if (identity.eventType !== outerEventType) {
    throw new Error('FCM V3 outer event type does not match authenticated identity');
  }

  const iv = frame.subarray(ivStart, tagStart);
  const tag = frame.subarray(tagStart, ciphertextStart);
  const ciphertext = frame.subarray(ciphertextStart);
  const key = await AESEncryptionKey.import(decodeFcmDeviceEncryptionKey(keyBase64Url));
  const sealed = AESSealedData.fromParts(iv, ciphertext, tag);
  const plaintext = await aesDecryptAsync(sealed, key, {
    additionalData: aad,
    output: 'bytes',
  });
  return { plaintext: decodeStrictUtf8(plaintext), identity };
}
