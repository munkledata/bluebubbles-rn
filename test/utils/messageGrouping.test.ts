import type { MessageRow } from '@db/repositories';
import {
  GROUP_BREAK_MS,
  sameSender,
  showAvatar,
  showDateSeparator,
  showSenderHeader,
  showTail,
  showTimestampAbove,
  TAIL_GAP_MS,
} from '@utils';

function m(partial: Partial<MessageRow>): MessageRow {
  return {
    id: 0,
    guid: 'g',
    chatId: 1,
    handleId: null,
    text: '',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 0,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...partial,
  };
}

describe('sameSender', () => {
  it('matches by isFromMe and handle', () => {
    expect(sameSender(m({ isFromMe: 1 }), m({ isFromMe: 1 }))).toBe(true);
    expect(sameSender(m({ isFromMe: 1 }), m({ isFromMe: 0 }))).toBe(false);
    expect(sameSender(m({ isFromMe: 0, handleId: 5 }), m({ isFromMe: 0, handleId: 5 }))).toBe(true);
    expect(sameSender(m({ isFromMe: 0, handleId: 5 }), m({ isFromMe: 0, handleId: 6 }))).toBe(
      false,
    );
  });
});

describe('showTail', () => {
  it('tails the newest message and run-enders', () => {
    expect(showTail(m({ dateCreated: 100 }), null)).toBe(true);
    const a = m({ isFromMe: 1, dateCreated: 1000 });
    expect(showTail(a, m({ isFromMe: 1, dateCreated: 1000 + TAIL_GAP_MS / 2 }))).toBe(false);
    expect(showTail(a, m({ isFromMe: 1, dateCreated: 1000 + TAIL_GAP_MS * 2 }))).toBe(true);
    expect(showTail(a, m({ isFromMe: 0, dateCreated: 1001 }))).toBe(true); // different sender
  });
});

describe('showSenderHeader', () => {
  it('only for received messages at a group start in group chats', () => {
    expect(showSenderHeader(m({ isFromMe: 1 }), null, true)).toBe(false);
    expect(showSenderHeader(m({ isFromMe: 0 }), null, false)).toBe(false); // 1:1
    expect(showSenderHeader(m({ isFromMe: 0 }), null, true)).toBe(true); // first in group
    const cur = m({ isFromMe: 0, handleId: 1, dateCreated: 10_000_000 });
    expect(
      showSenderHeader(cur, m({ isFromMe: 0, handleId: 1, dateCreated: 10_000_000 - 1000 }), true),
    ).toBe(false);
    expect(
      showSenderHeader(cur, m({ isFromMe: 0, handleId: 2, dateCreated: 9_999_000 }), true),
    ).toBe(true);
    expect(
      showSenderHeader(
        cur,
        m({ isFromMe: 0, handleId: 1, dateCreated: 10_000_000 - GROUP_BREAK_MS * 2 }),
        true,
      ),
    ).toBe(true);
  });
});

describe('showAvatar', () => {
  it('shows at the bottom of a received group only', () => {
    expect(showAvatar(m({ isFromMe: 0 }), null, true)).toBe(true);
    expect(showAvatar(m({ isFromMe: 0 }), null, false)).toBe(false);
    expect(showAvatar(m({ isFromMe: 1 }), null, true)).toBe(false);
  });
});

describe('showDateSeparator', () => {
  it('shows for the first message and across a >30min day boundary', () => {
    expect(showDateSeparator(m({ dateCreated: 1000 }), null)).toBe(true);
    const day1 = new Date(2024, 0, 1, 23, 0).getTime();
    const day2 = new Date(2024, 0, 2, 1, 0).getTime(); // +2h, next day
    expect(showDateSeparator(m({ dateCreated: day2 }), m({ dateCreated: day1 }))).toBe(true);
    const close = m({ dateCreated: day1 + 60_000 });
    expect(showDateSeparator(close, m({ dateCreated: day1 }))).toBe(false); // <30min
  });
});

describe('showTimestampAbove', () => {
  it('stamps the first message and any message in a new clock-minute', () => {
    const base = new Date(2024, 0, 1, 14, 30, 10).getTime(); // 2:30:10 PM
    expect(showTimestampAbove(m({ dateCreated: base }), null)).toBe(true); // first message
    // Same minute (2:30) → no stamp, even 40s later.
    expect(showTimestampAbove(m({ dateCreated: base + 40_000 }), m({ dateCreated: base }))).toBe(
      false,
    );
    // Next minute (2:31) → stamp, regardless of sender.
    const nextMin = new Date(2024, 0, 1, 14, 31, 5).getTime();
    expect(showTimestampAbove(m({ dateCreated: nextMin }), m({ dateCreated: base }))).toBe(true);
  });
});
