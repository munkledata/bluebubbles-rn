import { GuidDeduper } from '@core/sync';

describe('GuidDeduper', () => {
  it('marks new guids and rejects repeats', () => {
    const d = new GuidDeduper();
    expect(d.markIfNew('a')).toBe(true);
    expect(d.markIfNew('a')).toBe(false);
    expect(d.markIfNew('b')).toBe(true);
    expect(d.has('a')).toBe(true);
  });

  it('evicts oldest entries past capacity', () => {
    const d = new GuidDeduper(2);
    d.markIfNew('a');
    d.markIfNew('b');
    d.markIfNew('c'); // evicts 'a'
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    expect(d.has('c')).toBe(true);
    // 'a' is now treated as new again
    expect(d.markIfNew('a')).toBe(true);
  });
});
