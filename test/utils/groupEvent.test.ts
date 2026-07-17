import { buildGroupEventText, isChatBackgroundChangeEvent, isGroupEvent } from '@utils';

describe('isGroupEvent', () => {
  it('is false for a normal message (itemType 0, no title)', () => {
    expect(isGroupEvent({ itemType: 0, groupActionType: 0, groupTitle: null })).toBe(false);
    expect(isGroupEvent({})).toBe(false);
  });

  it('is true when itemType > 0, groupActionType > 0, or a groupTitle is present', () => {
    expect(isGroupEvent({ itemType: 1 })).toBe(true);
    expect(isGroupEvent({ groupActionType: 1 })).toBe(true);
    expect(isGroupEvent({ groupTitle: 'Trip' })).toBe(true);
  });
});

describe('buildGroupEventText', () => {
  it('participant add / remove (itemType 1)', () => {
    expect(
      buildGroupEventText({
        itemType: 1,
        groupActionType: 0,
        senderName: 'Alice',
        otherHandleName: 'Bob',
      }),
    ).toBe('Alice added Bob to the conversation.');
    expect(
      buildGroupEventText({
        itemType: 1,
        groupActionType: 1,
        senderName: 'Alice',
        otherHandleName: 'Bob',
      }),
    ).toBe('Alice removed Bob from the conversation.');
  });

  it('rename vs remove-name (itemType 2)', () => {
    expect(buildGroupEventText({ itemType: 2, senderName: 'Alice', groupTitle: 'Trip' })).toBe(
      'Alice named the conversation "Trip".',
    );
    expect(buildGroupEventText({ itemType: 2, senderName: 'Alice', groupTitle: null })).toBe(
      'Alice removed the name from the conversation.',
    );
  });

  it('leave / photo change / photo remove / background change / background remove (itemType 3)', () => {
    expect(buildGroupEventText({ itemType: 3, groupActionType: 0, senderName: 'Alice' })).toBe(
      'Alice left the conversation.',
    );
    expect(buildGroupEventText({ itemType: 3, groupActionType: 1, senderName: 'Alice' })).toBe(
      'Alice changed the group photo.',
    );
    expect(buildGroupEventText({ itemType: 3, groupActionType: 2, senderName: 'Alice' })).toBe(
      'Alice removed the group photo.',
    );
    expect(buildGroupEventText({ itemType: 3, groupActionType: 4, senderName: 'Alice' })).toBe(
      'Alice changed the chat background.',
    );
    expect(buildGroupEventText({ itemType: 3, groupActionType: 6, senderName: 'Alice' })).toBe(
      'Alice removed the chat background.',
    );
  });

  it('itemType 3 with an unconfirmed groupActionType (3 or 5) falls back to unknown', () => {
    expect(buildGroupEventText({ itemType: 3, groupActionType: 3, senderName: 'Alice' })).toBe(
      'Unknown group event',
    );
    expect(buildGroupEventText({ itemType: 3, groupActionType: 5, senderName: 'Alice' })).toBe(
      'Unknown group event',
    );
  });

  it('location, kept audio, SharePlay (itemType 4/5/6)', () => {
    expect(buildGroupEventText({ itemType: 4, groupActionType: 0, senderName: 'Alice' })).toBe(
      'Alice shared their location.',
    );
    expect(buildGroupEventText({ itemType: 5, senderName: 'Alice' })).toBe(
      'Alice kept an audio message.',
    );
    expect(buildGroupEventText({ itemType: 6, senderName: 'Alice' })).toBe('Alice started SharePlay.');
  });

  it('uses "You" for own events and "your" in the location phrasing', () => {
    expect(buildGroupEventText({ itemType: 4, groupActionType: 0, isFromMe: 1 })).toBe(
      'You shared your location.',
    );
    expect(
      buildGroupEventText({ itemType: 1, groupActionType: 0, isFromMe: 1, otherHandleName: 'Bob' }),
    ).toBe('You added Bob to the conversation.');
  });

  it('falls back to "Someone" / "someone" when names are unknown', () => {
    expect(buildGroupEventText({ itemType: 1, groupActionType: 0 })).toBe(
      'Someone added someone to the conversation.',
    );
  });
});

describe('isChatBackgroundChangeEvent', () => {
  it('is true only for itemType 3 with groupActionType 4 (changed) or 6 (removed)', () => {
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 4 })).toBe(true);
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 6 })).toBe(true);
  });

  it('is false for other itemType 3 actions, other itemTypes, and normal messages', () => {
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 0 })).toBe(false);
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 1 })).toBe(false);
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 3 })).toBe(false);
    expect(isChatBackgroundChangeEvent({ itemType: 3, groupActionType: 5 })).toBe(false);
    expect(isChatBackgroundChangeEvent({ itemType: 1, groupActionType: 4 })).toBe(false);
    expect(isChatBackgroundChangeEvent({ itemType: 0, groupActionType: 0 })).toBe(false);
    expect(isChatBackgroundChangeEvent({})).toBe(false);
  });
});
