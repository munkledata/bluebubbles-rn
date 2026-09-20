import {
  firstInboxSearchBigram,
  foldInboxSearchText,
  uniqueInboxSearchBigrams,
} from '@db/repositories/inboxSearchText';

describe('inbox search text and index keys', () => {
  it('uses the same whole-string NFC and lowercase order as the current inbox search', () => {
    expect(foldInboxSearchText('Cafe\u0301')).toBe('café');
    expect(foldInboxSearchText('İstanbul')).toBe('i\u0307stanbul');
  });

  it.each([
    ['Café, Bob', 'fe\u0301'],
    ['İstanbul', 'i\u0307s'],
    ['A😀B', '\ude00b'],
    ['ab\0cd', '\0c'],
  ])('indexes a required pair for an exact substring match in %s', (text, query) => {
    const foldedText = foldInboxSearchText(text);
    const foldedQuery = foldInboxSearchText(query);
    expect(foldedText.includes(foldedQuery)).toBe(true);
    expect(uniqueInboxSearchBigrams(foldedText)).toContain(firstInboxSearchBigram(foldedQuery));
  });

  it('deduplicates pairs and rejects a query without a pair', () => {
    expect(uniqueInboxSearchBigrams('aaaa')).toEqual([97 * 65_536 + 97]);
    expect(uniqueInboxSearchBigrams('')).toEqual([]);
    expect(() => firstInboxSearchBigram('a')).toThrow(RangeError);
  });
});
