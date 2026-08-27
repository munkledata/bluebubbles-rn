import {
  MAX_MESSAGE_NOTIFICATION_HISTORY,
  decodeMessageHistoryIds,
  encodeMessageHistoryIds,
  mergeMessageNotificationHistory,
  removeMessageFromNotificationHistory,
  type MessageNotificationHistoryEntry,
} from '@/services/notifications/messageHistory';

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
