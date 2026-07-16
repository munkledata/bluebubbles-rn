import {
  avatarSeed,
  chatServiceFromGuid,
  dedupeParticipants,
  isGroupRow,
  isHexColor,
  isRcsChatGuid,
  participantAvatars,
  participantList,
  resolveBubbleColor,
  resolveChatService,
  resolveTitle,
  type TitleInput,
} from '@utils/chat';

const base: TitleInput = {
  customName: null,
  displayName: null,
  chatIdentifier: null,
  style: null,
  participantCount: 1,
  participantNames: null,
};

describe('resolveTitle', () => {
  it('prefers the local custom name over everything', () => {
    expect(
      resolveTitle({
        ...base,
        customName: ' Fam ',
        displayName: 'Family',
        participantNames: 'Alice',
      }),
    ).toBe('Fam');
  });

  it('uses a real server display name when there is no custom name', () => {
    expect(resolveTitle({ ...base, displayName: 'Family', participantNames: 'Alice, Bob' })).toBe(
      'Family',
    );
  });

  it('skips a raw chat-guid display name in favor of participant names', () => {
    expect(
      resolveTitle({
        ...base,
        displayName: 'chat947991747861991169',
        participantNames: 'Alice, Bob',
      }),
    ).toBe('Alice, Bob');
  });

  it('skips a phone-number-list display name in favor of participant names', () => {
    expect(
      resolveTitle({
        ...base,
        displayName: '(209) 430-4494, (215) 954-8728',
        participantNames: 'Alice, Bob',
      }),
    ).toBe('Alice, Bob');
  });

  it('falls back to a phone-number-list display name when no participants resolved', () => {
    expect(resolveTitle({ ...base, displayName: '(209) 430-4494, (215) 954-8728' })).toBe(
      '(209) 430-4494, (215) 954-8728',
    );
  });

  it('falls back to a phone/email chat identifier for a bare 1:1', () => {
    expect(resolveTitle({ ...base, chatIdentifier: '+15551234567' })).toBe('+15551234567');
  });

  it('never surfaces a raw chat-guid — returns "Group" when nothing else is usable', () => {
    expect(resolveTitle({ ...base, displayName: 'chat123', chatIdentifier: 'chat123' })).toBe(
      'Group',
    );
    expect(resolveTitle(base)).toBe('Group');
  });
});

describe('isRcsChatGuid / chatServiceFromGuid', () => {
  it('detects the RCS bridge guid prefix', () => {
    expect(isRcsChatGuid('RCS;-;123')).toBe(true);
    expect(isRcsChatGuid('iMessage;-;+1555')).toBe(false);
    expect(isRcsChatGuid(null)).toBe(false);
    expect(isRcsChatGuid(undefined)).toBe(false);
  });

  it('derives the service from the guid prefix', () => {
    expect(chatServiceFromGuid('RCS;-;123')).toBe('RCS');
    expect(chatServiceFromGuid('SMS;-;+1555')).toBe('SMS');
    expect(chatServiceFromGuid('iMessage;-;+1555')).toBe('iMessage');
    expect(chatServiceFromGuid('anything-else')).toBe('iMessage');
    expect(chatServiceFromGuid(null)).toBeNull();
    expect(chatServiceFromGuid('')).toBeNull();
  });
});

describe('resolveChatService', () => {
  it('trusts a non-iMessage guid outright (RCS / real SMS)', () => {
    expect(resolveChatService('RCS;-;1', 'iMessage')).toBe('RCS');
    expect(resolveChatService('SMS;-;+1555', 'iMessage,iMessage')).toBe('SMS');
    expect(resolveChatService(null, 'SMS')).toBeNull();
  });

  it('overrides an iMessage guid to SMS when every handle is SMS', () => {
    expect(resolveChatService('iMessage;-;433768', 'SMS')).toBe('SMS');
    expect(resolveChatService('iMessage;-;g', 'SMS, SMS ,SMS')).toBe('SMS');
  });

  it('keeps iMessage when any handle is iMessage or handles are absent', () => {
    expect(resolveChatService('iMessage;-;g', 'SMS,iMessage')).toBe('iMessage');
    expect(resolveChatService('iMessage;-;g', '')).toBe('iMessage');
    expect(resolveChatService('iMessage;-;g', null)).toBe('iMessage');
    expect(resolveChatService('iMessage;-;g', ' , ')).toBe('iMessage');
  });
});

describe('isHexColor / resolveBubbleColor', () => {
  it('accepts only a 6-digit hex color', () => {
    expect(isHexColor('#1982FC')).toBe(true);
    expect(isHexColor('#abcdef')).toBe(true);
    expect(isHexColor('#FFF')).toBe(false); // shorthand not allowed
    expect(isHexColor('1982FC')).toBe(false); // missing #
    expect(isHexColor('#12345G')).toBe(false);
    expect(isHexColor(null)).toBe(false);
    expect(isHexColor(undefined)).toBe(false);
  });

  it('uses the custom color only when valid, else the theme fallback', () => {
    expect(resolveBubbleColor('#FF0000', '#1982FC')).toBe('#FF0000');
    expect(resolveBubbleColor('red', '#1982FC')).toBe('#1982FC');
    expect(resolveBubbleColor(null, '#1982FC')).toBe('#1982FC');
  });
});

describe('isGroupRow', () => {
  it('trusts style when present: 43 = group, 45 = DM', () => {
    expect(isGroupRow({ style: 43, participantCount: 1 })).toBe(true);
    // A DM whose contact texts from two handles must stay a single avatar.
    expect(isGroupRow({ style: 45, participantCount: 2 })).toBe(false);
  });

  it('falls back to participant count when style is unknown', () => {
    expect(isGroupRow({ style: null, participantCount: 2 })).toBe(true);
    expect(isGroupRow({ style: null, participantCount: 1 })).toBe(false);
  });
});

describe('avatarSeed', () => {
  it('seeds a 1:1 from the other party, then the identifier, then "?"', () => {
    expect(avatarSeed({ ...base, style: 45, participantNames: 'Alice, Bob' })).toBe('Alice');
    expect(avatarSeed({ ...base, style: 45, chatIdentifier: '+1555' })).toBe('+1555');
    expect(avatarSeed({ ...base, style: 45 })).toBe('?');
  });

  it('seeds a group from the display name, then participant names, then "?"', () => {
    expect(
      avatarSeed({ ...base, style: 43, displayName: ' Family ', participantNames: 'A, B' }),
    ).toBe('Family');
    expect(avatarSeed({ ...base, style: 43, participantNames: 'A, B' })).toBe('A, B');
    expect(avatarSeed({ ...base, style: 43 })).toBe('?');
  });
});

describe('participantList / participantAvatars', () => {
  it('splits, trims, and drops empty names', () => {
    expect(participantList(' Alice ,Bob,, ')).toEqual(['Alice', 'Bob']);
    expect(participantList(null)).toEqual([]);
  });

  it('splits pipe-delimited avatar uris, mapping empties to null', () => {
    expect(participantAvatars('file:///a.png|||')).toEqual(['file:///a.png', null]);
    expect(participantAvatars(null)).toEqual([]);
  });
});

describe('dedupeParticipants', () => {
  it('collapses the same person reachable via multiple handles', () => {
    const { names, uris } = dedupeParticipants(
      ['Alice', 'Alice', 'Bob'],
      ['file:///a.png', 'file:///a.png', null],
    );
    expect(names).toEqual(['Alice', 'Bob']);
    expect(uris).toEqual(['file:///a.png', null]);
  });

  it('keeps same-named entries whose avatar uris differ (genuinely different people)', () => {
    const { names } = dedupeParticipants(['Alice', 'Alice'], ['file:///a.png', 'file:///b.png']);
    expect(names).toEqual(['Alice', 'Alice']);
  });

  it('treats a missing uri slot as null when the arrays are ragged', () => {
    const { names, uris } = dedupeParticipants(['Alice', 'Alice'], ['file:///a.png']);
    expect(names).toEqual(['Alice', 'Alice']);
    expect(uris).toEqual(['file:///a.png', null]);
  });
});
