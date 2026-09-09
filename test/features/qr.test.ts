import {
  buildSetupQr,
  parseSetupQr,
  SetupQrBuildError,
  SetupQrParseError,
  type SetupQrParseErrorCode,
} from '@features/setup/qr';

function expectParseError(raw: string | null | undefined, code: SetupQrParseErrorCode): void {
  try {
    parseSetupQr(raw);
    throw new Error('Expected parseSetupQr to reject malformed input.');
  } catch (error) {
    expect(error).toBeInstanceOf(SetupQrParseError);
    expect(error).toMatchObject({ code });
  }
}

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
    expectParseError('', 'empty');
    expectParseError(null, 'empty');
  });

  it('throws on non-JSON', () => {
    expectParseError('not-json', 'invalid-json');
  });

  it('throws when the array is too short', () => {
    expectParseError(JSON.stringify(['only-password']), 'invalid-shape');
  });

  it('throws when password or URL is missing/invalid', () => {
    expectParseError(JSON.stringify(['', 'abc.ngrok.io']), 'missing-credentials');
    expectParseError(JSON.stringify(['pw', '']), 'missing-credentials');
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
    expect(() => buildSetupQr('', 'pw')).toThrow(SetupQrBuildError);
    expect(() => buildSetupQr('https://gator.example', '')).toThrow(SetupQrBuildError);
  });
});
