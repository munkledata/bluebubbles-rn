import {
  PICKER_ORDER,
  parseReactionType,
  reactionMeta,
  removalType,
  stripAssociatedGuidPrefix,
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

  describe('stripAssociatedGuidPrefix', () => {
    it('strips the p:0/ text-part prefix', () => {
      expect(stripAssociatedGuidPrefix('p:0/ABC-123')).toBe('ABC-123');
    });
    it('strips the bp:0/ attachment-part prefix', () => {
      expect(stripAssociatedGuidPrefix('bp:0/ABC-123')).toBe('ABC-123');
    });
    it('leaves a bare guid (no prefix) untouched', () => {
      expect(stripAssociatedGuidPrefix('ABC-123')).toBe('ABC-123');
    });
  });
});
