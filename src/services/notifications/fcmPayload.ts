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
   * The envelope says the server encrypted the `data` body. When true, `body` is the base64
   * ciphertext frame (not JSON) and the caller must decrypt it before dispatch — see
   * {@link encryptionType}. An UNSUPPORTED scheme is logged + skipped rather than failing
   * schema validation silently. A later sync may recover server-backed state, but cannot recreate
   * one-time events such as `message-send-error`.
   */
  encrypted: boolean;
  /**
   * The encryption scheme id (envelope sibling). Random-key V2 is accepted only through its
   * bounded compatibility cutoff; identity-bound V3 is current. Empty when not encrypted.
   */
  encryptionType: string;
}

/**
 * Chat identity travels inside `data` only. An envelope-level `chatGuid` sibling is ignored: the
 * Gator server never sends one, and an accepted push is encrypted, so merging it into the body
 * could never apply (review M099).
 */
export function parseFcmData(data: Record<string, unknown> | undefined): ParsedFcm {
  return {
    eventName: String(data?.type ?? ''),
    body: data?.data ?? data,
    encrypted: String(data?.encrypted ?? '').toLowerCase() === 'true',
    encryptionType: String(data?.encryptionType ?? ''),
  };
}
