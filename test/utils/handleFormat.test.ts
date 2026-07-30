/**
 * formatHandleAddress / addressMatchesTitle (src/utils/handleFormat.ts) — the pure half of the
 * "show the contact's number under their name in the chat header" feature.
 *
 * The formatter is deliberately conservative: only the two NANP shapes we can be sure about are
 * reformatted. These tests pin that conservatism, because the failure mode of an over-eager
 * formatter (silently mangling a real international number the user has to dial) is much worse
 * than showing a raw one.
 */
import {
  addressMatchesTitle,
  formatHandleAddress,
  participantAddressList,
  primaryChatAddress,
} from '@utils/handleFormat';

describe('formatHandleAddress', () => {
  it('formats a bare 10-digit NANP number', () => {
    expect(formatHandleAddress('5551234567')).toBe('(555) 123-4567');
  });

  it('formats an 11-digit 1-prefixed number with the country code', () => {
    expect(formatHandleAddress('+15551234567')).toBe('+1 (555) 123-4567');
    expect(formatHandleAddress('15551234567')).toBe('+1 (555) 123-4567');
  });

  it('normalizes an already-formatted number to the canonical shape', () => {
    expect(formatHandleAddress('+1 (555) 123-4567')).toBe('+1 (555) 123-4567');
    expect(formatHandleAddress('555-123-4567')).toBe('(555) 123-4567');
    expect(formatHandleAddress('(555) 123.4567')).toBe('(555) 123-4567');
  });

  it('returns emails untouched', () => {
    expect(formatHandleAddress('Alice@Example.com')).toBe('Alice@Example.com');
  });

  it('leaves a short code alone', () => {
    expect(formatHandleAddress('433768')).toBe('433768');
  });

  it('leaves a non-NANP international number alone rather than mangling it', () => {
    expect(formatHandleAddress('+442071838750')).toBe('+442071838750');
    expect(formatHandleAddress('+81 3-1234-5678')).toBe('+81 3-1234-5678');
  });

  it('leaves an alphanumeric sender id alone', () => {
    expect(formatHandleAddress('AMAZON')).toBe('AMAZON');
    expect(formatHandleAddress('GOOGLE-VERIFY')).toBe('GOOGLE-VERIFY');
  });

  it('is empty for empty/nullish input', () => {
    expect(formatHandleAddress('')).toBe('');
    expect(formatHandleAddress('   ')).toBe('');
    expect(formatHandleAddress(null)).toBe('');
    expect(formatHandleAddress(undefined)).toBe('');
  });
});

describe('addressMatchesTitle', () => {
  it('matches the same number written differently (no duplicate line in the header)', () => {
    expect(addressMatchesTitle('+15551234567', '(555) 123-4567')).toBe(true);
    expect(addressMatchesTitle('5551234567', '+1 555 123 4567')).toBe(true);
  });

  it('does not match a real name', () => {
    expect(addressMatchesTitle('+15551234567', 'Alice')).toBe(false);
    expect(addressMatchesTitle('alice@example.com', 'Alice')).toBe(false);
  });

  it('matches an email case-insensitively', () => {
    expect(addressMatchesTitle('Alice@Example.com', 'alice@example.com')).toBe(true);
  });

  it('does not match two different numbers', () => {
    expect(addressMatchesTitle('+15551234567', '(555) 999-0000')).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(addressMatchesTitle('', 'Alice')).toBe(false);
    expect(addressMatchesTitle('+15551234567', '')).toBe(false);
    expect(addressMatchesTitle(null, undefined)).toBe(false);
  });
});

describe('participantAddressList', () => {
  it('splits the |||-joined column and drops blanks', () => {
    expect(participantAddressList('+15551234567|||alice@example.com')).toEqual([
      '+15551234567',
      'alice@example.com',
    ]);
    expect(participantAddressList('+15551234567||| |||')).toEqual(['+15551234567']);
    expect(participantAddressList(null)).toEqual([]);
    expect(participantAddressList('')).toEqual([]);
  });
});

describe('primaryChatAddress', () => {
  it('picks the sole handle', () => {
    expect(
      primaryChatAddress({ chatIdentifier: '+15551234567', participantAddresses: '+15551234567' }),
    ).toBe('+15551234567');
  });

  it('prefers the handle the thread is keyed on when the contact has two', () => {
    expect(
      primaryChatAddress({
        chatIdentifier: 'alice@example.com',
        participantAddresses: '+15551234567|||alice@example.com',
      }),
    ).toBe('alice@example.com');
  });

  it('falls back to the first handle when the identifier is not one of them', () => {
    expect(
      primaryChatAddress({
        chatIdentifier: '+19998887777',
        participantAddresses: '+15551234567|||alice@example.com',
      }),
    ).toBe('+15551234567');
  });

  it('falls back to the identifier when no handles have synced yet', () => {
    expect(primaryChatAddress({ chatIdentifier: '+15551234567' })).toBe('+15551234567');
    expect(
      primaryChatAddress({ chatIdentifier: '+15551234567', participantAddresses: null }),
    ).toBe('+15551234567');
  });

  it('never returns a raw chat-guid identifier (it is not an address)', () => {
    expect(primaryChatAddress({ chatIdentifier: 'chat947991747861991169' })).toBe('');
    expect(
      primaryChatAddress({
        chatIdentifier: 'chat947991747861991169',
        participantAddresses: '+15551234567',
      }),
    ).toBe('+15551234567');
  });

  it('matches the identifier to a handle across formatting differences', () => {
    expect(
      primaryChatAddress({
        chatIdentifier: '+1 (555) 123-4567',
        participantAddresses: 'bob@example.com|||5551234567',
      }),
    ).toBe('+1 (555) 123-4567');
  });

  it('is empty when there is nothing at all', () => {
    expect(primaryChatAddress({})).toBe('');
    expect(primaryChatAddress({ chatIdentifier: null, participantAddresses: null })).toBe('');
  });
});
