import { parseSetupQr } from '@features/setup/qr';

describe('parseSetupQr', () => {
  it('parses a valid [password, serverURL] payload and sanitizes the origin', () => {
    const result = parseSetupQr(JSON.stringify(['secret-pw', 'abc.ngrok.io']));
    expect(result).toEqual({ password: 'secret-pw', origin: 'https://abc.ngrok.io' });
  });

  it('strips path/query from the scanned URL down to the origin', () => {
    const result = parseSetupQr(JSON.stringify(['pw', 'https://x.com/api/v1?guid=zzz']));
    expect(result.origin).toBe('https://x.com');
  });

  it('throws on empty input', () => {
    expect(() => parseSetupQr('')).toThrow(/No data/);
    expect(() => parseSetupQr(null)).toThrow(/No data/);
  });

  it('throws on non-JSON', () => {
    expect(() => parseSetupQr('not-json')).toThrow(/valid BlueBubbles QR/);
  });

  it('throws when the array is too short', () => {
    expect(() => parseSetupQr(JSON.stringify(['only-password']))).toThrow(/Invalid data/);
  });

  it('throws when password or URL is missing/invalid', () => {
    expect(() => parseSetupQr(JSON.stringify(['', 'abc.ngrok.io']))).toThrow(/Could not detect/);
    expect(() => parseSetupQr(JSON.stringify(['pw', '']))).toThrow(/Could not detect/);
  });
});
