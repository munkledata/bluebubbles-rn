import {
  contactEmailMatchKey,
  contactHandleMatchKey,
  contactHandleNationalMatchKeys,
  contactNationalMatchKey,
  contactPhoneMatchKey,
  digitsOnly,
  emailKey,
  handleKey,
  phoneKey,
} from '@utils';

describe('contactMatch', () => {
  it('digitsOnly strips non-digits', () => {
    expect(digitsOnly('+1 (555) 123-4567')).toBe('15551234567');
  });

  it('phoneKey collapses country code + formatting to the last 10 digits', () => {
    expect(phoneKey('+15551234567')).toBe('5551234567');
    expect(phoneKey('555-123-4567')).toBe('5551234567');
    expect(phoneKey('+1 (555) 123 4567')).toBe('5551234567');
  });

  it('phoneKey keeps short numbers unchanged', () => {
    expect(phoneKey('911')).toBe('911');
  });

  it('emailKey lowercases + trims', () => {
    expect(emailKey(' Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('handleKey routes by address type', () => {
    expect(handleKey('a@b.com')).toBe('a@b.com');
    expect(handleKey('+1 555 123 4567')).toBe('5551234567');
  });

  it('contact match keys separate phone/email namespaces and reject empty values', () => {
    expect(contactPhoneMatchKey('+1 555 123 4567')).toBe('phone:5551234567');
    expect(contactEmailMatchKey(' 1234 ')).toBe('email:1234');
    expect(contactHandleMatchKey('+1 555 123 4567')).toBe('phone:5551234567');
    expect(contactHandleMatchKey('A@B.COM')).toBe('email:a@b.com');
    expect(contactPhoneMatchKey('not-a-number')).toBe('');
    expect(contactEmailMatchKey('   ')).toBe('');
  });

  it('gives a national fallback key only to local numbers with one trunk 0', () => {
    expect(contactNationalMatchKey('0401 111 111')).toBe('national:401111111'); // Australia
    expect(contactNationalMatchKey('07700 900123')).toBe('national:7700900123'); // UK
    expect(contactNationalMatchKey('030 1234567')).toBe('national:301234567'); // Germany
    // International forms, North American numbers and short codes get none.
    expect(contactNationalMatchKey('+61 401 111 111')).toBe('');
    expect(contactNationalMatchKey('0061 401 111 111')).toBe('');
    expect(contactNationalMatchKey('(555) 123-4567')).toBe('');
    expect(contactNationalMatchKey('1 555 123 4567')).toBe('');
    expect(contactNationalMatchKey('012345')).toBe('');
    expect(contactNationalMatchKey('')).toBe('');
  });

  it('offers an international handle its number without a 1-, 2- or 3-digit country code', () => {
    expect(contactHandleNationalMatchKeys('+61401111111')).toEqual([
      'national:1401111111',
      'national:401111111',
    ]);
    expect(contactHandleNationalMatchKeys('+447700900123')).toEqual([
      'national:47700900123',
      'national:7700900123',
      'national:700900123',
    ]);
    // Not international, an email, or too short to compare.
    expect(contactHandleNationalMatchKeys('5551234567')).toEqual([]);
    // North American numbers are already compared exactly by their last ten digits.
    expect(contactHandleNationalMatchKeys('+15551234567')).toEqual([]);
    expect(contactHandleNationalMatchKeys('a+b@example.com')).toEqual([]);
    expect(contactHandleNationalMatchKeys('12345')).toEqual([]);
    expect(contactHandleNationalMatchKeys('+123456')).toEqual([]);
  });
});
