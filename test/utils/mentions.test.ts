import { activeMentionQuery, computeMentionRanges } from '@utils';

describe('computeMentionRanges', () => {
  it('resolves a mention label to its span in the final text', () => {
    const text = 'hey @Alice look';
    expect(computeMentionRanges(text, [{ address: 'a@x.com', label: '@Alice' }])).toEqual([
      { start: 4, length: 6, address: 'a@x.com' },
    ]);
  });

  it('maps two mentions (incl. duplicate labels) to distinct, non-overlapping spans', () => {
    const text = '@Alice and @Alice again';
    const ranges = computeMentionRanges(text, [
      { address: 'a@x.com', label: '@Alice' },
      { address: 'a@x.com', label: '@Alice' },
    ]);
    expect(ranges).toEqual([
      { start: 0, length: 6, address: 'a@x.com' },
      { start: 11, length: 6, address: 'a@x.com' },
    ]);
  });

  it('drops a mention whose label was edited away', () => {
    expect(computeMentionRanges('hey there', [{ address: 'a@x.com', label: '@Alice' }])).toEqual(
      [],
    );
  });

  it('sorts spans by start regardless of pick order', () => {
    const text = '@Bob and @Alice';
    const ranges = computeMentionRanges(text, [
      { address: 'a@x.com', label: '@Alice' },
      { address: 'b@x.com', label: '@Bob' },
    ]);
    expect(ranges.map((r) => r.address)).toEqual(['b@x.com', 'a@x.com']);
  });
});

describe('activeMentionQuery', () => {
  it('detects an @query at the cursor (start of string)', () => {
    expect(activeMentionQuery('@Al', 3)).toEqual({ atIndex: 0, query: 'Al' });
  });

  it('detects an @query after whitespace', () => {
    expect(activeMentionQuery('hey @bo', 7)).toEqual({ atIndex: 4, query: 'bo' });
  });

  it('does NOT trigger inside an email address (@ not after whitespace)', () => {
    expect(activeMentionQuery('a@x', 3)).toBeNull();
  });

  it('is null when whitespace follows the @ before the cursor', () => {
    expect(activeMentionQuery('@Al ', 4)).toBeNull();
  });
});
