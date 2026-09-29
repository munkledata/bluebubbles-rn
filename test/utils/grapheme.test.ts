import { graphemeBoundaries } from '@/utils/grapheme';

describe('grapheme boundaries', () => {
  it('keeps emoji and combining sequences intact when Hermes has no Intl.Segmenter', () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const original = intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      const value = 'A👨‍👩‍👧‍👦é B';
      const boundaries = graphemeBoundaries(value);
      expect([...boundaries].sort((left, right) => left - right)).toEqual([0, 1, 12, 14, 15, 16]);
      expect(boundaries.has(2)).toBe(false);
      expect(boundaries.has(13)).toBe(false);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });
});
