import { parseReactionType, removalType } from '@core/reactions/reactionType';

describe('parseReactionType — arbitrary-emoji tapbacks (iOS 18 / macOS 15)', () => {
  it("parses the 'emoji' selector as a reaction (glyph travels separately)", () => {
    expect(parseReactionType('emoji')).toEqual({ baseType: 'emoji', isRemoval: false });
  });

  it("parses '-emoji' as a removal", () => {
    expect(parseReactionType('-emoji')).toEqual({ baseType: 'emoji', isRemoval: true });
  });

  it('still parses classic tapbacks unchanged', () => {
    expect(parseReactionType('love')).toEqual({ baseType: 'love', isRemoval: false });
    expect(parseReactionType('-laugh')).toEqual({ baseType: 'laugh', isRemoval: true });
  });

  it('still rejects non-reaction associated types', () => {
    expect(parseReactionType('sticker')).toBeNull();
    expect(parseReactionType('emojis')).toBeNull(); // not the exact selector
    expect(parseReactionType(null)).toBeNull();
  });

  it("removalType works for the emoji kind ('-emoji')", () => {
    expect(removalType('emoji')).toBe('-emoji');
    expect(removalType('love')).toBe('-love');
  });
});
