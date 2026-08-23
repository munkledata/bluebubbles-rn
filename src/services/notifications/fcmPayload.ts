/**
 * Parse a Gator FCM data message into (eventName, body) for the EventRouter.
 *
 * The server's FCM envelope is `{ type: '<event>', data: '<JSON body>', ...metadata }`:
 * the event name is under `type`, and the body is nested under `data` (a JSON string),
 * with metadata keys (`encrypted`, `partial`, `encoding`, `subtype`, ...) as siblings.
 * This mirrors the Flutter client's `ServerPayload.fromJson`, which reads the body from
 * `json['data'] ?? json` — NOT a top-level `payload` key (which the server never sends).
 *
 * Kept FREE of the `@react-native-firebase` import so it stays unit-testable without the
 * native module. The body is returned as-is (usually a JSON string); the realtime normalizer
 * JSON-parses it before schema validation.
 */
export interface ParsedFcm {
  eventName: string;
  body: unknown;
  /**
   * Optional compatibility metadata carried beside `data`. The current Gator server normally
   * keeps chat identity inside the serialized body, but retaining this sibling lets the caller
   * merge it back after decrypting an envelope produced by another compatible server build.
   */
  envelopeChatGuid: string | undefined;
  /**
   * The server encrypted the `data` body (the `encryptComs` setting). When true, `body` is
   * the base64 ciphertext frame (not JSON) and the caller must decrypt it before dispatch —
   * see {@link encryptionType}. An UNSUPPORTED scheme is logged + skipped (the message still
   * arrives on the next sync) rather than failing schema validation silently.
   */
  encrypted: boolean;
  /**
   * The encryption scheme id (envelope sibling). `'AEAD_GCM_V1'` is the supported shared
   * scheme (AES-256-GCM — see {@link file://./fcmDecrypt.ts}); `''` when not encrypted.
   */
  encryptionType: string;
}

export function parseFcmData(data: Record<string, unknown> | undefined): ParsedFcm {
  const envelopeChatGuid = nonEmptyString(data?.chatGuid);
  return {
    eventName: String(data?.type ?? ''),
    body: rehydrateFcmEnvelopeChatGuid(data?.data ?? data, envelopeChatGuid),
    envelopeChatGuid,
    encrypted: String(data?.encrypted ?? '').toLowerCase() === 'true',
    encryptionType: String(data?.encryptionType ?? ''),
  };
}

/**
 * Fold an optional envelope `chatGuid` INTO a plaintext body, where the Message schema reads it.
 * The current Gator server sends only `{ type, data }` and normally includes chat identity inside
 * `data`; the sibling is compatibility tolerance for other builds, not a required server field.
 *
 * This helper is also called AFTER decryption. Calling it only in {@link parseFcmData} cannot work
 * for an encrypted lean body because the ciphertext is not JSON yet. A body-owned `chatGuid`
 * always wins, and the original string/object representation is preserved.
 */
export function rehydrateFcmEnvelopeChatGuid(
  body: unknown,
  envelopeChatGuid: string | undefined,
): unknown {
  if (!envelopeChatGuid) return body;
  const obj = asObject(body);
  if (!obj || typeof obj.chatGuid === 'string') return body;
  const merged = { ...obj, chatGuid: envelopeChatGuid };
  // Preserve the JSON-string form the realtime normalizer expects to re-parse.
  return typeof body === 'string' ? JSON.stringify(merged) : merged;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse a JSON string (or accept an object) into a plain record; null on anything else. */
function asObject(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
