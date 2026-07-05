import { formatSmsAddress } from '@core/sms';

describe('formatSmsAddress', () => {
  it('groups a bare 10-digit US number', () => {
    expect(formatSmsAddress('5551234567')).toBe('(555) 123-4567');
  });

  it('groups a formatted 10-digit number', () => {
    expect(formatSmsAddress('(555) 123-4567')).toBe('(555) 123-4567');
    expect(formatSmsAddress('555-123-4567')).toBe('(555) 123-4567');
  });

  it('groups an 11-digit +1 number with a leading +1', () => {
    expect(formatSmsAddress('+1 555 123 4567')).toBe('+1 (555) 123-4567');
    expect(formatSmsAddress('15551234567')).toBe('+1 (555) 123-4567');
  });

  it('passes short codes through verbatim', () => {
    expect(formatSmsAddress('262966')).toBe('262966');
    expect(formatSmsAddress('22000')).toBe('22000');
  });

  it('passes email gateways and unknown shapes through trimmed', () => {
    expect(formatSmsAddress('  user@example.com ')).toBe('user@example.com');
    expect(formatSmsAddress('+44 20 7946 0018')).toBe('+44 20 7946 0018');
  });

  it('handles empty / whitespace input', () => {
    expect(formatSmsAddress('')).toBe('');
    expect(formatSmsAddress('   ')).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatSmsAddress(undefined as any)).toBe('');
  });
});
