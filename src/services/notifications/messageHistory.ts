/** Keep Android-owned per-chat preview state useful without allowing it to grow without bound. */
export const MAX_MESSAGE_NOTIFICATION_HISTORY = 6;
export const MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS = 512;
export const MAX_MESSAGE_NOTIFICATION_TEXT_BYTES = 2_048;
export const MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS = 128;
export const MAX_MESSAGE_NOTIFICATION_LABEL_BYTES = 512;
export const MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES = 4_096;
export const MESSAGE_HISTORY_IDS_KEY = 'messageHistoryIds';

const encoder = new TextEncoder();

export interface MessageNotificationHistoryEntry {
  /** Opaque, device-local SQLite row id. Never a server GUID or address. */
  messageId: number;
  text: string;
  timestamp: number;
  senderName: string;
  avatarUri?: string;
}

/** Build a whole-code-point prefix without encoding or normalizing an arbitrarily large input. */
function boundedPrefix(value: string, maxCodePoints: number, maxBytes: number): string {
  let result = '';
  let codePoints = 0;
  let bytes = 0;
  for (const codePoint of value) {
    if (codePoints >= maxCodePoints) break;
    const nextBytes = encoder.encode(codePoint).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    result += codePoint;
    codePoints += 1;
    bytes += nextBytes;
  }
  return result;
}

function boundedNormalizedPrefix(
  value: unknown,
  maxCodePoints: number,
  maxBytes: number,
  trim: boolean,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let result = boundedPrefix(value, maxCodePoints, maxBytes);
  try {
    result = result.normalize('NFC');
  } catch {
    return undefined;
  }
  if (trim) result = result.trim();
  result = boundedPrefix(result, maxCodePoints, maxBytes);
  return result.length > 0 ? result : undefined;
}

/** Notification preview text keeps its whitespace but never crosses the native bridge unbounded. */
export function normalizeMessageNotificationText(value: unknown): string | undefined {
  return boundedNormalizedPrefix(
    value,
    MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS,
    MAX_MESSAGE_NOTIFICATION_TEXT_BYTES,
    false,
  );
}

/** Sender labels are presentation-only and trim padding that adds no useful identity. */
export function normalizeMessageNotificationLabel(value: unknown): string | undefined {
  return boundedNormalizedPrefix(
    value,
    MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS,
    MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
    true,
  );
}

export function normalizeMessageNotificationTitle(value: unknown): string | undefined {
  return normalizeMessageNotificationLabel(value);
}

/** Never truncate or normalize a URI: either preserve the exact reference or omit it. */
export function normalizeMessageNotificationAvatarUri(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES ||
    value.trim().length === 0
  ) {
    return undefined;
  }
  return encoder.encode(value).byteLength <= MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES
    ? value
    : undefined;
}

export function normalizeMessageNotificationHistoryEntry(
  entry: MessageNotificationHistoryEntry,
): MessageNotificationHistoryEntry | null {
  if (
    !Number.isSafeInteger(entry.messageId) ||
    entry.messageId <= 0 ||
    !Number.isFinite(entry.timestamp)
  ) {
    return null;
  }
  const text = normalizeMessageNotificationText(entry.text);
  const senderName = normalizeMessageNotificationLabel(entry.senderName);
  if (!text || !senderName) return null;
  const avatarUri = normalizeMessageNotificationAvatarUri(entry.avatarUri);
  return {
    messageId: entry.messageId,
    text,
    timestamp: entry.timestamp,
    senderName,
    ...(avatarUri ? { avatarUri } : {}),
  };
}

/** Normalize, deduplicate, deterministically order, and cap any native-facing history. */
export function normalizeMessageNotificationHistory(
  entries: readonly MessageNotificationHistoryEntry[],
): MessageNotificationHistoryEntry[] {
  const byId = new Map<number, MessageNotificationHistoryEntry>();
  for (const entry of entries) {
    const normalized = normalizeMessageNotificationHistoryEntry(entry);
    if (normalized) byId.set(normalized.messageId, normalized);
  }
  return [...byId.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.messageId - right.messageId)
    .slice(-MAX_MESSAGE_NOTIFICATION_HISTORY);
}

/** Replace duplicate deliveries, order deterministically, and retain only the newest six lines. */
export function mergeMessageNotificationHistory(
  existing: readonly MessageNotificationHistoryEntry[],
  incoming: MessageNotificationHistoryEntry,
): MessageNotificationHistoryEntry[] {
  return normalizeMessageNotificationHistory([...existing, incoming]);
}

/** Encode only local integer ids; line text/name remain in Android's normal MessagingStyle array. */
export function encodeMessageHistoryIds(
  entries: readonly MessageNotificationHistoryEntry[],
): string {
  return entries.map((entry) => String(entry.messageId)).join(',');
}

/** Fail closed unless the parallel id list exactly matches the bounded MessagingStyle line count. */
export function decodeMessageHistoryIds(encoded: unknown, expectedCount: number): number[] | null {
  if (
    typeof encoded !== 'string' ||
    encoded.length > 127 ||
    expectedCount < 1 ||
    expectedCount > MAX_MESSAGE_NOTIFICATION_HISTORY
  ) {
    return null;
  }
  const parts = encoded.split(',');
  if (parts.length !== expectedCount || parts.some((part) => !/^[1-9]\d*$/.test(part))) {
    return null;
  }
  const ids = parts.map((part) => Number(part));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return null;
  }
  return ids;
}
