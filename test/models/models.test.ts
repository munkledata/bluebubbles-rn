import { Chat, isGroup, isReaction, Message } from '@core/models';

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
});

describe('Chat model', () => {
  it('identifies group chats by style or participant count', () => {
    expect(isGroup(Chat.parse({ guid: 'c', style: 45 }))).toBe(true);
    expect(
      isGroup(Chat.parse({ guid: 'c', participants: [{ address: 'a' }, { address: 'b' }] })),
    ).toBe(true);
    expect(isGroup(Chat.parse({ guid: 'c', participants: [{ address: 'a' }] }))).toBe(false);
  });
});
