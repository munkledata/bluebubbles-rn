import { digitsOnly, emailKey, handleKey, phoneKey } from '@utils';

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
});
