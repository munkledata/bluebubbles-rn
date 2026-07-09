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
 * native module. The body is returned as-is (usually a JSON string); the EventRouter's
 * `coerceData` JSON-parses it before schema validation.
 */
export interface ParsedFcm {
  eventName: string;
  body: unknown;
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
  return {
    eventName: String(data?.type ?? ''),
    body: hoistChatGuid(data?.data ?? data, data?.chatGuid),
    encrypted: String(data?.encrypted ?? '').toLowerCase() === 'true',
    encryptionType: String(data?.encryptionType ?? ''),
  };
}

/**
 * Live `new-message` / `updated-message` pushes carry a top-level `chatGuid` on the FCM
 * envelope (sibling to `type`/`data`) as the defensive fallback for when the server didn't
 * embed `chats[]` in the message body. Fold it INTO the body (where the Message schema reads
 * it) so the chats-less fallback in DbEventSink/buildMessageIntents can resolve the chat.
 * The body is usually a JSON string at this point — parse, inject, re-stringify (the
 * EventRouter's `coerceData` re-parses it). Only injected when the body lacks its own.
 */
function hoistChatGuid(body: unknown, envelopeChatGuid: unknown): unknown {
  if (typeof envelopeChatGuid !== 'string' || envelopeChatGuid.length === 0) return body;
  const obj = asObject(body);
  if (!obj || typeof obj.chatGuid === 'string') return body;
  const merged = { ...obj, chatGuid: envelopeChatGuid };
  // Preserve the JSON-string form the EventRouter expects to re-parse.
  return typeof body === 'string' ? JSON.stringify(merged) : merged;
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
