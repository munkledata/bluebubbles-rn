import {
  MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES,
  MAX_MESSAGE_NOTIFICATION_HISTORY,
  MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
  MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS,
  MAX_MESSAGE_NOTIFICATION_TEXT_BYTES,
  MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS,
  decodeMessageHistoryIds,
  encodeMessageHistoryIds,
  mergeMessageNotificationHistory,
  normalizeMessageNotificationHistory,
  normalizeMessageNotificationHistoryEntry,
  removeMessageFromNotificationHistory,
  type MessageNotificationHistoryEntry,
} from '@/services/notifications/messageHistory';

const encoder = new TextEncoder();

function entry(messageId: number, text = `line ${messageId}`): MessageNotificationHistoryEntry {
  return { messageId, text, timestamp: messageId, senderName: 'Contact' };
}

it('keeps a bounded unique history with an exact opaque-id codec and targeted removal', () => {
  let history: MessageNotificationHistoryEntry[] = [];
  for (let id = 1; id <= MAX_MESSAGE_NOTIFICATION_HISTORY + 1; id += 1) {
    history = mergeMessageNotificationHistory(history, entry(id));
  }
  history = mergeMessageNotificationHistory(history, entry(7, 'updated seven'));

  expect(history.map(({ messageId }) => messageId)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(history.at(-1)?.text).toBe('updated seven');
  expect(mergeMessageNotificationHistory(history, entry(1))).toEqual(history);
  const encoded = encodeMessageHistoryIds(history);
  expect(decodeMessageHistoryIds(encoded, history.length)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(decodeMessageHistoryIds('2,2', 2)).toBeNull();
  expect(
    removeMessageFromNotificationHistory(history, 4).map(({ messageId }) => messageId),
  ).toEqual([2, 3, 5, 6, 7]);
});

it('normalizes every native-facing string within code-point and UTF-8 bounds', () => {
  const oversizedAvatar = `file:///${'a'.repeat(MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES)}`;
  const normalized = normalizeMessageNotificationHistoryEntry({
    messageId: 9,
    text: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS + 1),
    timestamp: 9,
    senderName: `  ${'e\u0301'.repeat(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS + 1)}  `,
    avatarUri: oversizedAvatar,
  });

  expect(normalized).not.toBeNull();
  expect([...normalized!.text]).toHaveLength(MAX_MESSAGE_NOTIFICATION_TEXT_CODE_POINTS);
  expect(encoder.encode(normalized!.text)).toHaveLength(MAX_MESSAGE_NOTIFICATION_TEXT_BYTES);
  expect([...normalized!.senderName]).toHaveLength(
    Math.floor(MAX_MESSAGE_NOTIFICATION_LABEL_CODE_POINTS / 2) - 1,
  );
  expect(normalized!.senderName).toBe(normalized!.senderName.normalize('NFC').trim());
  expect(encoder.encode(normalized!.senderName).byteLength).toBeLessThanOrEqual(
    MAX_MESSAGE_NOTIFICATION_LABEL_BYTES,
  );
  expect(normalized).not.toHaveProperty('avatarUri');

  const exactAvatar = `x`.repeat(MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES);
  const exact = normalizeMessageNotificationHistoryEntry({
    ...entry(10),
    avatarUri: exactAvatar,
  });
  expect(exact?.avatarUri).toBe(exactAvatar);
  const byteOversizedAvatar = normalizeMessageNotificationHistoryEntry({
    ...entry(11),
    avatarUri: '😀'.repeat(MAX_MESSAGE_NOTIFICATION_AVATAR_URI_BYTES / 4 + 1),
  });
  expect(byteOversizedAvatar).not.toHaveProperty('avatarUri');
  expect(normalizeMessageNotificationHistory([normalized!, normalized!])).toEqual([normalized]);
});
