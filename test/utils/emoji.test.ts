import { isBigEmoji } from '@utils';

describe('isBigEmoji', () => {
  it('is true for 1–3 emoji only', () => {
    expect(isBigEmoji('😀')).toBe(true);
    expect(isBigEmoji('😀😍')).toBe(true);
    expect(isBigEmoji('😀 😍 🎉')).toBe(true); // whitespace ignored
    expect(isBigEmoji('👍🏽')).toBe(true); // skin-tone modifier counts as one
    expect(isBigEmoji('👨‍👩‍👧')).toBe(true); // one ZWJ family sequence (≤3 pictographs)
    expect(isBigEmoji('🇺🇸')).toBe(true); // a flag (one regional-indicator pair)
  });

  it('is false when there is any non-emoji text', () => {
    expect(isBigEmoji('hi 😀')).toBe(false);
    expect(isBigEmoji('😀!')).toBe(false);
    expect(isBigEmoji('ok')).toBe(false);
  });

  it('is false for empty/blank and for 4+ emoji', () => {
    expect(isBigEmoji('')).toBe(false);
    expect(isBigEmoji('   ')).toBe(false);
    expect(isBigEmoji(null)).toBe(false);
    expect(isBigEmoji('😀😀😀😀')).toBe(false);
  });
});
