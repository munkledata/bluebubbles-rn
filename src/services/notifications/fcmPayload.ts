/**
 * Parse a BlueBubbles FCM data message into (eventName, body) for the EventRouter.
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
   * The server encrypted this payload with its legacy AES scheme (`encryptionType: AES_PB`).
   * This RN client uses libsodium, NOT that scheme, so it cannot decrypt the push — but the
   * message is not lost: it arrives on the next sync. The caller logs + skips it rather than
   * failing schema validation silently.
   */
  encrypted: boolean;
}

export function parseFcmData(data: Record<string, unknown> | undefined): ParsedFcm {
  return {
    eventName: String(data?.type ?? ''),
    body: data?.data ?? data,
    encrypted: String(data?.encrypted ?? '').toLowerCase() === 'true',
  };
}
