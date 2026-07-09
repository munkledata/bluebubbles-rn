import {
  avatarSeed,
  buildPreview,
  chatServiceFromGuid,
  dedupeParticipants,
  formatChatDate,
  isGroupRow,
  resolveTitle,
} from '@utils';

// Fixed "now": Wed 2024-01-17 12:00 local.
const NOW = new Date(2024, 0, 17, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).getTime();

describe('formatChatDate', () => {
  it('returns empty for null/0', () => {
    expect(formatChatDate(null, NOW)).toBe('');
    expect(formatChatDate(0, NOW)).toBe('');
  });

  it('shows a time for same-day messages', () => {
    const out = formatChatDate(at(2024, 0, 17, 9, 5), NOW);
    expect(out).toMatch(/\d{1,2}:\d{2}/); // e.g. "9:05 AM"
  });

  it('shows "Yesterday" for the prior calendar day', () => {
    expect(formatChatDate(at(2024, 0, 16, 23, 0), NOW)).toBe('Yesterday');
  });

  it('shows a weekday name within the past week', () => {
    // 2024-01-14 was a Sunday, 3 days before the 17th
    expect(formatChatDate(at(2024, 0, 14), NOW)).toBe('Sunday');
  });

  it('shows month/day for older same-year messages', () => {
    const out = formatChatDate(at(2024, 0, 1), NOW); // 16 days earlier
    expect(out).toMatch(/Jan/);
  });

  it('shows a numeric date across years', () => {
    const out = formatChatDate(at(2022, 5, 15), NOW);
    expect(out).toMatch(/22/); // 2-digit year present
  });
});

describe('buildPreview', () => {
  const base = {
    lastGuid: 'g',
    lastText: 'hello',
    lastSubject: null,
    lastIsFromMe: 0 as number | null,
    lastHasAttachments: 0 as number | null,
    lastAssociatedType: null as string | null,
  };

  it('adds "You: " only for outgoing messages', () => {
    expect(buildPreview(base)).toBe('hello');
    expect(buildPreview({ ...base, lastIsFromMe: 1 })).toBe('You: hello');
  });

  it('shows an attachment placeholder when text is empty', () => {
    expect(buildPreview({ ...base, lastText: null, lastHasAttachments: 1 })).toBe('📎 Attachment');
  });

  it('relabels reactions', () => {
    expect(buildPreview({ ...base, lastText: null, lastAssociatedType: 'love' })).toBe(
      'Loved a message',
    );
  });

  it('returns empty for an empty chat', () => {
    expect(buildPreview({ ...base, lastGuid: null, lastText: null })).toBe('');
  });
});

describe('chat resolution', () => {
  it('resolves title by precedence', () => {
    expect(
      resolveTitle({
        displayName: 'Fam',
        chatIdentifier: 'x',
        style: 45,
        participantCount: 3,
        participantNames: 'A, B',
      }),
    ).toBe('Fam');
    expect(
      resolveTitle({
        displayName: null,
        chatIdentifier: 'x',
        style: 45,
        participantCount: 2,
        participantNames: 'A, B',
      }),
    ).toBe('A, B');
    expect(
      resolveTitle({
        displayName: null,
        chatIdentifier: 'chat-id',
        style: 43,
        participantCount: 1,
        participantNames: null,
      }),
    ).toBe('chat-id');
  });

  it('a custom name overrides the server name', () => {
    expect(
      resolveTitle({
        customName: 'BFFs',
        displayName: 'Fam',
        chatIdentifier: 'x',
        style: 45,
        participantCount: 3,
        participantNames: 'A, B',
      }),
    ).toBe('BFFs');
    // a blank/whitespace custom name falls through to the next source
    expect(
      resolveTitle({
        customName: '  ',
        displayName: 'Fam',
        chatIdentifier: 'x',
        style: 45,
        participantCount: 3,
        participantNames: 'A, B',
      }),
    ).toBe('Fam');
  });

  it('detects groups by iMessage style (43=group, 45=DM), falling back to participant count', () => {
    // style 45 is a 1:1 DM → single avatar, even if extra handles inflate the count.
    expect(isGroupRow({ style: 45, participantCount: 1 })).toBe(false);
    expect(isGroupRow({ style: 45, participantCount: 2 })).toBe(false);
    // style 43 is a group, regardless of the (sometimes under-synced) participant count.
    expect(isGroupRow({ style: 43, participantCount: 2 })).toBe(true);
    expect(isGroupRow({ style: 43, participantCount: 1 })).toBe(true);
    // unknown style → fall back to the participant count.
    expect(isGroupRow({ style: null, participantCount: 2 })).toBe(true);
    expect(isGroupRow({ style: null, participantCount: 1 })).toBe(false);
  });

  it('seeds a 1:1 avatar from the single participant', () => {
    expect(
      avatarSeed({
        displayName: null,
        chatIdentifier: 'x',
        style: 45, // 45 = DM
        participantCount: 1,
        participantNames: 'Alice',
      }),
    ).toBe('Alice');
  });
});

describe('dedupeParticipants', () => {
  it('collapses a member that appears twice (two handles, same photo)', () => {
    // Carol is reachable via two handles → same name + same avatar repeated.
    const parts = dedupeParticipants(
      ['Carol', 'Carol', 'Bob'],
      ['c.jpg', 'c.jpg', 'b.jpg'],
    );
    expect(parts.names).toEqual(['Carol', 'Bob']);
    expect(parts.uris).toEqual(['c.jpg', 'b.jpg']);
  });

  it('keeps distinct people whose names differ', () => {
    const parts = dedupeParticipants(['Alice', 'Bob'], [null, null]);
    expect(parts.names).toEqual(['Alice', 'Bob']);
    expect(parts.uris).toEqual([null, null]);
  });

  it('does not collapse same name with different photos', () => {
    const parts = dedupeParticipants(['Sam', 'Sam'], ['a.jpg', 'b.jpg']);
    expect(parts.names).toEqual(['Sam', 'Sam']);
  });

  it('handles empty and single-element inputs', () => {
    expect(dedupeParticipants([], [])).toEqual({ names: [], uris: [] });
    expect(dedupeParticipants(['Alice'], [null])).toEqual({ names: ['Alice'], uris: [null] });
  });
});

describe('chatServiceFromGuid', () => {
  it('maps the guid prefix to a service (for the inbox badge)', () => {
    expect(chatServiceFromGuid('RCS;-;123')).toBe('RCS');
    expect(chatServiceFromGuid('SMS;-;+15551234567')).toBe('SMS');
    expect(chatServiceFromGuid('iMessage;-;+15551234567')).toBe('iMessage');
    expect(chatServiceFromGuid(null)).toBeNull();
  });
});
