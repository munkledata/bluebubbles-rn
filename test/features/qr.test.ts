import { buildSetupQr, parseSetupQr } from '@features/setup/qr';

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
    expect(() => parseSetupQr('not-json')).toThrow(/valid Gator QR/);
  });

  it('throws when the array is too short', () => {
    expect(() => parseSetupQr(JSON.stringify(['only-password']))).toThrow(/Invalid data/);
  });

  it('throws when password or URL is missing/invalid', () => {
    expect(() => parseSetupQr(JSON.stringify(['', 'abc.ngrok.io']))).toThrow(/Could not detect/);
    expect(() => parseSetupQr(JSON.stringify(['pw', '']))).toThrow(/Could not detect/);
  });
});

describe('buildSetupQr', () => {
  it('emits the [password, serverURL] JSON array shape', () => {
    const payload = buildSetupQr('https://gator.example', 'secret-pw');
    expect(JSON.parse(payload)).toEqual(['secret-pw', 'https://gator.example']);
  });

  it('round-trips through parseSetupQr (the app can scan its own displayed QR)', () => {
    const payload = buildSetupQr('https://gator.example', 's3cr3t!');
    expect(parseSetupQr(payload)).toEqual({ password: 's3cr3t!', origin: 'https://gator.example' });
  });

  it('sanitizes a messy origin before embedding it', () => {
    const payload = buildSetupQr('https://x.com/api/v1?guid=zzz', 'pw');
    expect(parseSetupQr(payload).origin).toBe('https://x.com');
  });

  it('throws when either credential is missing', () => {
    expect(() => buildSetupQr('', 'pw')).toThrow(/required/);
    expect(() => buildSetupQr('https://gator.example', '')).toThrow(/required/);
  });
});
