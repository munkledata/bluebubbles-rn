import {
  PICKER_ORDER,
  parseReactionType,
  reactionMeta,
  removalType,
} from '@core/reactions/reactionType';

describe('reactionType', () => {
  it('parses each base type (not a removal)', () => {
    for (const t of PICKER_ORDER) {
      const p = parseReactionType(t);
      expect(p).toEqual({ baseType: t, isRemoval: false });
    }
  });

  it('parses removals', () => {
    expect(parseReactionType('-love')).toEqual({ baseType: 'love', isRemoval: true });
    expect(parseReactionType('-question')).toEqual({ baseType: 'question', isRemoval: true });
  });

  it('rejects non-reaction types', () => {
    expect(parseReactionType('sticker')).toBeNull();
    expect(parseReactionType(null)).toBeNull();
    expect(parseReactionType('')).toBeNull();
  });

  it('exposes emoji + label and a removal wire string', () => {
    expect(reactionMeta('love').emoji).toBe('❤️');
    expect(reactionMeta('laugh').label).toBe('Laugh');
    expect(removalType('like')).toBe('-like');
  });
});
