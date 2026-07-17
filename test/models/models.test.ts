import { Chat, isGroup, isReaction, Message, parseMessageSummaryInfo } from '@core/models';

describe('Message model', () => {
  it('parses a minimal message and coerces string timestamps', () => {
    const m = Message.parse({
      guid: 'g',
      text: 'hi',
      dateCreated: '1700000000000',
      dateRead: null,
    });
    expect(m.guid).toBe('g');
    expect(m.dateCreated).toBe(1700000000000);
    expect(m.dateRead).toBeNull();
  });

  it('detects reactions vs reaction-removals', () => {
    expect(isReaction({ associatedMessageType: 'love' })).toBe(true);
    expect(isReaction({ associatedMessageType: '-love' })).toBe(false);
    expect(isReaction({ associatedMessageType: null })).toBe(false);
  });

  it('accepts and preserves a well-formed messageSummaryInfo (edit history + retracted parts)', () => {
    const m = Message.parse({
      guid: 'g',
      messageSummaryInfo: {
        editedParts: {
          '0': [
            { date: 100, text: 'v1' },
            { date: 200, text: 'v2' },
          ],
        },
        retractedParts: [1],
      },
    });
    expect(m.messageSummaryInfo?.editedParts?.['0']).toHaveLength(2);
    expect(m.messageSummaryInfo?.editedParts?.['0']?.[1]?.text).toBe('v2');
    expect(m.messageSummaryInfo?.retractedParts).toEqual([1]);
  });

  it('omits messageSummaryInfo when absent (presence-driven, like isScheduled)', () => {
    const m = Message.parse({ guid: 'g', text: 'hi' });
    expect(m.messageSummaryInfo).toBeUndefined();
  });

  it('tolerates a MALFORMED messageSummaryInfo without rejecting the whole message', () => {
    // A sync page is ONE hard array parse — a bad nested value must degrade to "absent", never fail
    // the whole message (which would stall the page). `.catch(undefined)` is the guard.
    const m = Message.parse({
      guid: 'g',
      text: 'hi',
      messageSummaryInfo: { editedParts: 'not-an-object' },
    });
    expect(m.guid).toBe('g');
    expect(m.text).toBe('hi');
    expect(m.messageSummaryInfo).toBeUndefined();
  });

  it('keeps the whole message even when messageSummaryInfo is wholesale garbage', () => {
    const m = Message.parse({ guid: 'g', messageSummaryInfo: 42 });
    expect(m.guid).toBe('g');
    expect(m.messageSummaryInfo).toBeUndefined();
  });

  it('parseMessageSummaryInfo round-trips valid JSON and returns null on garbage', () => {
    const info = { editedParts: { '0': [{ date: 1, text: 'a' }] }, retractedParts: [3] };
    expect(parseMessageSummaryInfo(JSON.stringify(info))).toEqual(info);
    expect(parseMessageSummaryInfo('{not json')).toBeNull();
    expect(parseMessageSummaryInfo(null)).toBeNull();
    expect(parseMessageSummaryInfo(undefined)).toBeNull();
    expect(parseMessageSummaryInfo('')).toBeNull();
  });
});

describe('Chat model', () => {
  it('identifies group chats by iMessage style (43=group, 45=DM) or participant count', () => {
    expect(isGroup(Chat.parse({ guid: 'c', style: 43 }))).toBe(true); // 43 = group
    expect(isGroup(Chat.parse({ guid: 'c', style: 45 }))).toBe(false); // 45 = 1:1 DM
    // no style → fall back to participant count
    expect(
      isGroup(Chat.parse({ guid: 'c', participants: [{ address: 'a' }, { address: 'b' }] })),
    ).toBe(true);
    expect(isGroup(Chat.parse({ guid: 'c', participants: [{ address: 'a' }] }))).toBe(false);
  });

  it('accepts and preserves the macOS read watermark (lastReadMessageTimestamp, Unix ms)', () => {
    const m = Chat.parse({ guid: 'c', lastReadMessageTimestamp: 1718900002000 });
    expect(m.lastReadMessageTimestamp).toBe(1718900002000);
  });

  it('tolerates a null lastReadMessageTimestamp ("never read on the Mac")', () => {
    const m = Chat.parse({ guid: 'c', lastReadMessageTimestamp: null });
    expect(m.lastReadMessageTimestamp).toBeNull();
  });

  it('omits lastReadMessageTimestamp when absent (presence-driven → undefined)', () => {
    const m = Chat.parse({ guid: 'c' });
    expect(m.lastReadMessageTimestamp).toBeUndefined();
  });
});
