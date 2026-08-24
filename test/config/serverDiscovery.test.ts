import {
  classifyServerRotation,
  isCleartext,
  MAX_SERVER_ORIGIN_INPUT_LENGTH,
  sanitizeServerAddress,
  strictServerOrigin,
} from '@core/config';

describe('sanitizeServerAddress', () => {
  it('adds https:// when no scheme is provided', () => {
    expect(sanitizeServerAddress('abc.ngrok.io')).toBe('https://abc.ngrok.io');
  });

  it('preserves an explicit http scheme (LAN/IP opt-in handled elsewhere)', () => {
    expect(sanitizeServerAddress('http://192.168.1.10:1234')).toBe('http://192.168.1.10:1234');
  });

  it('strips paths, queries and trailing slashes down to the origin', () => {
    expect(sanitizeServerAddress('https://x.com/api/v1/?guid=abc')).toBe('https://x.com');
    expect(sanitizeServerAddress('https://x.com///')).toBe('https://x.com');
  });

  it('returns null for empty/invalid input', () => {
    expect(sanitizeServerAddress('')).toBeNull();
    expect(sanitizeServerAddress(null)).toBeNull();
    expect(sanitizeServerAddress('   ')).toBeNull();
  });

  it('flags cleartext origins', () => {
    expect(isCleartext('http://x')).toBe(true);
    expect(isCleartext('https://x')).toBe(false);
  });
});

describe('strictServerOrigin', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['HTTPS://EXAMPLE.COM:443', 'https://example.com'],
    ['http://192.168.1.10:1234', 'http://192.168.1.10:1234'],
    ['https://[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
  ])('canonicalizes the strict origin %s', (input, expected) => {
    expect(strictServerOrigin(input)).toBe(expected);
  });

  it.each([
    '',
    ' example.com',
    'example.com',
    'https://user:secret@example.com',
    'https://@example.com',
    'https://:@example.com',
    'https://example.com/api',
    'https://example.com?next=https://evil.example',
    'https://example.com#fragment',
    'https://example.com?#',
    'https://example.com\\@evil.example',
    'https://example.com\n.evil.example',
    'javascript:alert(1)',
    'ws://example.com',
  ])('rejects non-origin or parser-smuggling input %p', (input) => {
    expect(strictServerOrigin(input)).toBeNull();
  });

  it('rejects an oversized untrusted origin before URL parsing', () => {
    const input = `https://${'a'.repeat(MAX_SERVER_ORIGIN_INPUT_LENGTH)}.example`;
    expect(strictServerOrigin(input)).toBeNull();
  });
});

describe('classifyServerRotation', () => {
  it('recognizes canonical spellings of the trusted origin as a no-op', () => {
    expect(classifyServerRotation('https://example.com', 'HTTPS://EXAMPLE.COM:443/')).toEqual({
      kind: 'same-origin',
      origin: 'https://example.com',
    });
  });

  it('offers a foreign HTTPS origin without cleartext consent', () => {
    expect(classifyServerRotation('https://old.example', 'https://new.example')).toEqual({
      kind: 'candidate',
      currentOrigin: 'https://old.example',
      candidateOrigin: 'https://new.example',
      requiresCleartextApproval: false,
    });
  });

  it('rejects an HTTPS-to-HTTP downgrade instead of offering it for approval', () => {
    expect(classifyServerRotation('https://same.example', 'http://same.example')).toEqual({
      kind: 'downgrade',
      currentOrigin: 'https://same.example',
      candidateOrigin: 'http://same.example',
    });
  });

  it('requires fresh cleartext consent when an approved HTTP session changes origin', () => {
    expect(classifyServerRotation('http://192.168.1.10:1234', 'http://192.168.1.11:1234')).toEqual({
      kind: 'candidate',
      currentOrigin: 'http://192.168.1.10:1234',
      candidateOrigin: 'http://192.168.1.11:1234',
      requiresCleartextApproval: true,
    });
  });

  it.each([
    ['missing current session', null, 'https://new.example'],
    ['userinfo', 'https://old.example', 'https://user:secret@new.example'],
    ['empty userinfo', 'https://old.example', 'https://@new.example'],
    ['empty user/password', 'https://old.example', 'https://:@new.example'],
    ['path', 'https://old.example', 'https://new.example/api'],
    ['query', 'https://old.example', 'https://new.example?next=evil'],
    ['fragment', 'https://old.example', 'https://new.example#target'],
    ['whitespace', 'https://old.example', ' https://new.example'],
  ])('rejects %s input', (_label, current, candidate) => {
    expect(classifyServerRotation(current, candidate)).toEqual({ kind: 'invalid' });
  });
});
