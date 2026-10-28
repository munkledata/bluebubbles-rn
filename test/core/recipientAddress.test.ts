import { canonicalRecipientAddress } from '@core/recipientAddress';

describe('canonicalRecipientAddress', () => {
  it.each([
    ['pat@example.com', 'pat@example.com'],
    ['  Pat.Example@Example.COM ', 'pat.example@example.com'],
    ['+15551234567', '+15551234567'],
    ['+1 (555) 123-4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+33.1.23.45.67.89', '+33123456789'],
    // The owner's region rule: ten digits without a country code are North American.
    ['5551234567', '+15551234567'],
    ['(555) 123-4567', '+15551234567'],
    ['555.123.4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['1-555-123-4567', '+15551234567'],
    // Address-book and pasted numbers can carry invisible direction marks.
    ['‪+1 555-123-4567‬', '+15551234567'],
    ['555​123​4567', '+15551234567'],
    ['555 123 4567', '+15551234567'],
  ])('standardizes %j as %j', (raw, expected) => {
    expect(canonicalRecipientAddress(raw)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Aar', 'a name'],
    ['555-1234', 'seven digits, no area code'],
    ['123456', 'a short code'],
    ['0555123456', 'ten digits starting with 0 (another country’s local format)'],
    ['1555123456', 'ten digits starting with 1'],
    ['07700 900123', 'a UK local number'],
    ['2 555 123 4567', 'eleven digits not starting with 1'],
    ['1 055 123 4567', 'eleven digits whose area code starts with 0'],
    ['+0 555 123 4567', 'a country code starting with 0'],
    ['+1234567890123456', 'more than 15 digits'],
    ['+', 'a bare plus'],
    ['1+5551234567', 'a plus that is not at the front'],
    ['+1 555 123 4567 x44', 'an extension'],
    ['+15551234567;ext=44', 'an extension parameter'],
    ['+44 (0)20 7946 0958', 'a domestic-only (0)'],
    ['555 CALL NOW', 'letters'],
    ['pat@', 'an email with no domain'],
    ['@example.com', 'an email with no name'],
    ['pat@example', 'an email domain without a dot'],
    ['pat example@example.com', 'an email with a space'],
    [`${'a'.repeat(243)}@example.com`, 'an email longer than 254 characters'],
  ])('refuses %j (%s)', (raw) => {
    expect(canonicalRecipientAddress(raw)).toBeNull();
  });

  it('accepts an email of exactly 254 characters', () => {
    const email = `${'a'.repeat(242)}@example.com`;
    expect(email).toHaveLength(254);
    expect(canonicalRecipientAddress(email)).toBe(email);
  });
});
