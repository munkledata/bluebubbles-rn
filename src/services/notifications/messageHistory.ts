/** Keep Android-owned per-chat preview state useful without allowing it to grow without bound. */
export const MAX_MESSAGE_NOTIFICATION_HISTORY = 6;
export const MESSAGE_HISTORY_IDS_KEY = 'messageHistoryIds';

export interface MessageNotificationHistoryEntry {
  /** Opaque, device-local SQLite row id. Never a server GUID or address. */
  messageId: number;
  text: string;
  timestamp: number;
  senderName: string;
  avatarUri?: string;
}

function validEntry(entry: MessageNotificationHistoryEntry): boolean {
  return (
    Number.isSafeInteger(entry.messageId) &&
    entry.messageId > 0 &&
    typeof entry.text === 'string' &&
    entry.text.length > 0 &&
    Number.isFinite(entry.timestamp) &&
    typeof entry.senderName === 'string' &&
    entry.senderName.length > 0 &&
    (entry.avatarUri == null || (typeof entry.avatarUri === 'string' && entry.avatarUri.length > 0))
  );
}

/** Replace duplicate deliveries, order deterministically, and retain only the newest six lines. */
export function mergeMessageNotificationHistory(
  existing: readonly MessageNotificationHistoryEntry[],
  incoming: MessageNotificationHistoryEntry,
): MessageNotificationHistoryEntry[] {
  const byId = new Map<number, MessageNotificationHistoryEntry>();
  for (const entry of existing) {
    if (validEntry(entry)) byId.set(entry.messageId, entry);
  }
  if (validEntry(incoming)) byId.set(incoming.messageId, incoming);

  return [...byId.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.messageId - right.messageId)
    .slice(-MAX_MESSAGE_NOTIFICATION_HISTORY);
}

export function removeMessageFromNotificationHistory(
  existing: readonly MessageNotificationHistoryEntry[],
  messageId: number,
): MessageNotificationHistoryEntry[] {
  return existing.filter((entry) => validEntry(entry) && entry.messageId !== messageId);
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
