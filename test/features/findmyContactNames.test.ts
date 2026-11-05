import {
  buildContactNameIndex,
  contactNameForHandle,
} from '@features/findmy/useFindMyContactNames';

jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));

describe('Find My contact names', () => {
  const index = buildContactNameIndex([
    { name: 'Jordan Rivera', address: '+1 (555) 123-4567' },
    { name: 'Jordan Again', address: '555-123-4567' },
    { name: 'Sam Lee', address: 'SAM@example.com' },
    { name: '   ', address: 'blank@example.com' },
    { name: 'Digits Only', address: '1234' },
  ]);

  it('matches a phone number however it is formatted', () => {
    expect(contactNameForHandle(index, '+15551234567')).toBe('Jordan Rivera');
    expect(contactNameForHandle(index, '5551234567')).toBe('Jordan Rivera');
  });

  it('matches an email case-insensitively', () => {
    expect(contactNameForHandle(index, 'sam@EXAMPLE.com')).toBe('Sam Lee');
  });

  it('keeps the first contact when two share an address', () => {
    expect(contactNameForHandle(index, '+15551234567')).not.toBe('Jordan Again');
  });

  it('ignores blank names and never lets a phone key match an email', () => {
    expect(contactNameForHandle(index, 'blank@example.com')).toBeNull();
    expect(contactNameForHandle(index, '1234@example.com')).toBeNull();
  });

  it('returns null with no handle or no match', () => {
    expect(contactNameForHandle(index, null)).toBeNull();
    expect(contactNameForHandle(index, undefined)).toBeNull();
    expect(contactNameForHandle(index, '')).toBeNull();
    expect(contactNameForHandle(index, 'nobody@example.com')).toBeNull();
  });
});
