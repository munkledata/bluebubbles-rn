import { utf8Decode, utf8Encode } from '@utils/bytes';

/** Final scoped push scheme; V2 remains a bounded compatibility protocol during migration. */
export const FCM_PUSH_ENCRYPTION_TYPE_V3 = 'AEAD_GCM_V3_IDENTITY' as const;
export const FCM_PUSH_ENVELOPE_IDENTITY_VERSION = 3 as const;
export const FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES = 64;
export const FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES = 1_024;
export const FCM_PUSH_ENVELOPE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const MAGIC = Uint8Array.of(0x47, 0x54, 0x52, 0x50, 0x55, 0x53, 0x48, 0x00); // GTRPUSH\0
const FIELD_COUNT = 9;
const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 8;
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_EVENT_TYPE = /^[a-z][a-z0-9-]*$/;

const TAG = {
  eventType: 1,
  serverInstallationId: 2,
  principalId: 3,
  deviceId: 4,
  occurrenceId: 5,
  messagePresent: 6,
  messageId: 7,
  issuedAt: 8,
  expiresAt: 9,
} as const;

export interface FcmPushEnvelopeIdentityV3 {
  readonly version: typeof FCM_PUSH_ENVELOPE_IDENTITY_VERSION;
  readonly eventType: string;
  readonly serverInstallationId: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly occurrenceId: string;
  readonly messageId?: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function protocolError(reason: string): Error {
  return new Error(`invalid FCM push envelope identity: ${reason}`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function strictUtf8(value: string, label: string, maximumBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.includes('\0')) throw protocolError(label);
  const bytes = utf8Encode(value);
  if (bytes.length === 0 || bytes.length > maximumBytes) throw protocolError(label);
  // TextEncoder replaces unmatched UTF-16 surrogates. Round-tripping rejects that ambiguity.
  if (utf8Decode(bytes) !== value) throw protocolError(label);
  return bytes;
}

function strictDecodedText(bytes: Uint8Array, label: string, maximumBytes: number): string {
  if (bytes.length === 0 || bytes.length > maximumBytes) throw protocolError(label);
  const value = utf8Decode(bytes);
  if (value.includes('\0') || !equalBytes(utf8Encode(value), bytes)) throw protocolError(label);
  return value;
}

function eventTypeBytes(value: string): Uint8Array {
  const bytes = strictUtf8(value, 'event type', FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES);
  if (!CANONICAL_EVENT_TYPE.test(value)) throw protocolError('event type');
  return bytes;
}

function uuidBytes(value: string, label: string): Uint8Array {
  if (!CANONICAL_UUID_V4.test(value)) throw protocolError(label);
  const hex = value.replace(/-/g, '');
  const bytes = new Uint8Array(UUID_BYTES);
  for (let index = 0; index < UUID_BYTES; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function canonicalUuid(bytes: Uint8Array, label: string): string {
  if (bytes.length !== UUID_BYTES) throw protocolError(label);
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!CANONICAL_UUID_V4.test(value)) throw protocolError(label);
  return value;
}

function timestampBytes(value: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw protocolError(label);
  let remaining = value;
  const bytes = new Uint8Array(TIMESTAMP_BYTES);
  // Avoid a BigInt runtime dependency in a killed-app Hermes context. Safe integers can be split
  // exactly into a 21-bit high word and a 32-bit low word.
  const high = Math.floor(remaining / 0x1_0000_0000);
  remaining -= high * 0x1_0000_0000;
  bytes[0] = Math.floor(high / 0x1_0000_00) & 0xff;
  bytes[1] = Math.floor(high / 0x1_0000) & 0xff;
  bytes[2] = Math.floor(high / 0x100) & 0xff;
  bytes[3] = high & 0xff;
  bytes[4] = Math.floor(remaining / 0x1_0000_00) & 0xff;
  bytes[5] = Math.floor(remaining / 0x1_0000) & 0xff;
  bytes[6] = Math.floor(remaining / 0x100) & 0xff;
  bytes[7] = remaining & 0xff;
  return bytes;
}

function timestampFromBytes(bytes: Uint8Array, label: string): number {
  if (bytes.length !== TIMESTAMP_BYTES) throw protocolError(label);
  let high = 0;
  let low = 0;
  for (let index = 0; index < 4; index += 1) high = high * 256 + bytes[index]!;
  for (let index = 4; index < 8; index += 1) low = low * 256 + bytes[index]!;
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value)) throw protocolError(label);
  return value;
}

function assertLifetime(issuedAt: number, expiresAt: number): void {
  if (expiresAt <= issuedAt || expiresAt - issuedAt > FCM_PUSH_ENVELOPE_MAX_LIFETIME_MS) {
    throw protocolError('expiry');
  }
}

function field(tag: number, value: Uint8Array): Uint8Array {
  if (value.length > 0xffff) throw protocolError('field length');
  const encoded = new Uint8Array(3 + value.length);
  encoded[0] = tag;
  encoded[1] = value.length >>> 8;
  encoded[2] = value.length & 0xff;
  encoded.set(value, 3);
  return encoded;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Encode the exact identity bytes authenticated as AES-GCM additional data. */
export function encodeFcmPushEnvelopeIdentityV3(identity: FcmPushEnvelopeIdentityV3): Uint8Array {
  if (identity.version !== FCM_PUSH_ENVELOPE_IDENTITY_VERSION) throw protocolError('version');
  const hasMessageId = identity.messageId !== undefined;
  const message = hasMessageId
    ? strictUtf8(identity.messageId, 'message id', FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES)
    : new Uint8Array();
  const issuedAt = timestampBytes(identity.issuedAt, 'issue time');
  const expiresAt = timestampBytes(identity.expiresAt, 'expiry');
  assertLifetime(identity.issuedAt, identity.expiresAt);

  return concatenate([
    MAGIC,
    Uint8Array.of(FCM_PUSH_ENVELOPE_IDENTITY_VERSION, FIELD_COUNT),
    field(TAG.eventType, eventTypeBytes(identity.eventType)),
    field(
      TAG.serverInstallationId,
      uuidBytes(identity.serverInstallationId, 'server installation id'),
    ),
    field(TAG.principalId, uuidBytes(identity.principalId, 'principal id')),
    field(TAG.deviceId, uuidBytes(identity.deviceId, 'device id')),
    field(TAG.occurrenceId, uuidBytes(identity.occurrenceId, 'occurrence id')),
    field(TAG.messagePresent, Uint8Array.of(hasMessageId ? 1 : 0)),
    field(TAG.messageId, message),
    field(TAG.issuedAt, issuedAt),
    field(TAG.expiresAt, expiresAt),
  ]);
}

class IdentityReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw protocolError(label);
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  byte(label: string): number {
    return this.take(1, label)[0]!;
  }

  tagged(expectedTag: number, label: string): Uint8Array {
    if (this.byte(`${label} tag`) !== expectedTag) throw protocolError(`${label} tag`);
    const length = (this.byte(`${label} length`) << 8) | this.byte(`${label} length`);
    return this.take(length, label);
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** Decode only the canonical order, field set, lengths, and exact end of input. */
export function decodeFcmPushEnvelopeIdentityV3(bytes: Uint8Array): FcmPushEnvelopeIdentityV3 {
  if (!(bytes instanceof Uint8Array)) throw protocolError('input');
  const reader = new IdentityReader(bytes);
  if (!equalBytes(reader.take(MAGIC.length, 'magic'), MAGIC)) throw protocolError('magic');
  if (reader.byte('version') !== FCM_PUSH_ENVELOPE_IDENTITY_VERSION) {
    throw protocolError('version');
  }
  if (reader.byte('field count') !== FIELD_COUNT) throw protocolError('field count');

  const eventType = strictDecodedText(
    reader.tagged(TAG.eventType, 'event type'),
    'event type',
    FCM_PUSH_EVENT_TYPE_MAX_UTF8_BYTES,
  );
  if (!CANONICAL_EVENT_TYPE.test(eventType)) throw protocolError('event type');
  const serverInstallationId = canonicalUuid(
    reader.tagged(TAG.serverInstallationId, 'server installation id'),
    'server installation id',
  );
  const principalId = canonicalUuid(reader.tagged(TAG.principalId, 'principal id'), 'principal id');
  const deviceId = canonicalUuid(reader.tagged(TAG.deviceId, 'device id'), 'device id');
  const occurrenceId = canonicalUuid(
    reader.tagged(TAG.occurrenceId, 'occurrence id'),
    'occurrence id',
  );
  const messagePresence = reader.tagged(TAG.messagePresent, 'message presence');
  if (messagePresence.length !== 1 || (messagePresence[0] !== 0 && messagePresence[0] !== 1)) {
    throw protocolError('message presence');
  }
  const messageBytes = reader.tagged(TAG.messageId, 'message id');
  let messageId: string | undefined;
  if (messagePresence[0] === 0) {
    if (messageBytes.length !== 0) throw protocolError('message id');
  } else {
    messageId = strictDecodedText(messageBytes, 'message id', FCM_PUSH_MESSAGE_ID_MAX_UTF8_BYTES);
  }
  const issuedAt = timestampFromBytes(reader.tagged(TAG.issuedAt, 'issue time'), 'issue time');
  const expiresAt = timestampFromBytes(reader.tagged(TAG.expiresAt, 'expiry'), 'expiry');
  if (!reader.done()) throw protocolError('trailing data');
  assertLifetime(issuedAt, expiresAt);

  return {
    version: FCM_PUSH_ENVELOPE_IDENTITY_VERSION,
    eventType,
    serverInstallationId,
    principalId,
    deviceId,
    occurrenceId,
    ...(messageId === undefined ? {} : { messageId }),
    issuedAt,
    expiresAt,
  };
}
