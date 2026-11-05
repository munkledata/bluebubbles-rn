/**
 * `buildTapbackNotificationText`: a tapback notice's line, worded as on an iPhone. It quotes only
 * the exact part that was tapbacked, and says `an attachment` or `a message` when there is no text.
 */
import { buildTapbackNotificationText } from '@utils';

const TEXT = { text: 'dinner at 7?' };

describe('buildTapbackNotificationText', () => {
  it.each([
    ['love', 'Loved “dinner at 7?”'],
    ['like', 'Liked “dinner at 7?”'],
    ['dislike', 'Disliked “dinner at 7?”'],
    ['laugh', 'Laughed at “dinner at 7?”'],
    ['emphasize', 'Emphasized “dinner at 7?”'],
    ['question', 'Questioned “dinner at 7?”'],
  ])('words a %s tapback', (reactionType, expected) => {
    expect(buildTapbackNotificationText({ reactionType, emoji: null }, TEXT)).toBe(expected);
  });

  it('names the emoji of an emoji tapback, and leaves out one that is too long', () => {
    expect(buildTapbackNotificationText({ reactionType: 'emoji', emoji: '😂' }, TEXT)).toBe(
      'Reacted 😂 to “dinner at 7?”',
    );
    expect(
      buildTapbackNotificationText({ reactionType: 'emoji', emoji: 'x'.repeat(17) }, TEXT),
    ).toBe('Reacted to “dinner at 7?”');
    expect(buildTapbackNotificationText({ reactionType: 'emoji', emoji: null }, TEXT)).toBe(
      'Reacted to “dinner at 7?”',
    );
  });

  it('says what was tapbacked when there is no text to quote', () => {
    const love = { reactionType: 'love', emoji: null };
    expect(buildTapbackNotificationText(love, { text: '￼', hasVisibleAttachments: 1 })).toBe(
      'Loved an attachment',
    );
    expect(buildTapbackNotificationText(love, { text: null, hasAttachments: 1 })).toBe(
      'Loved an attachment',
    );
    expect(buildTapbackNotificationText(love, { text: null, hasVisibleAttachments: 0 })).toBe(
      'Loved a message',
    );
    // An unknown part: the caller passes no target, so nothing is quoted.
    expect(buildTapbackNotificationText(love, null)).toBe('Loved a message');
  });

  it('keeps a long or multi-line quote on one short line', () => {
    const long = 'a'.repeat(150);
    expect(
      buildTapbackNotificationText({ reactionType: 'like', emoji: null }, { text: long }),
    ).toBe(`Liked “${'a'.repeat(100)}…”`);
    expect(
      buildTapbackNotificationText(
        { reactionType: 'like', emoji: null },
        { text: 'see you\n\nat 6' },
      ),
    ).toBe('Liked “see you at 6”');
  });

  it('gives no line for a removal, a sticker, an unknown kind, or an unsent target', () => {
    expect(buildTapbackNotificationText({ reactionType: '-love', emoji: null }, TEXT)).toBeNull();
    expect(buildTapbackNotificationText({ reactionType: 'sticker', emoji: null }, TEXT)).toBeNull();
    expect(buildTapbackNotificationText({ reactionType: '2000', emoji: null }, TEXT)).toBeNull();
    expect(
      buildTapbackNotificationText(
        { reactionType: 'love', emoji: null },
        { text: 'gone', isRetracted: true },
      ),
    ).toBeNull();
  });
});
