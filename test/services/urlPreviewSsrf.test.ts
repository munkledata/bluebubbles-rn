import { isPrivateHost, isSafePreviewUrl } from '@/services/urlPreview';

describe('isPrivateHost (SSRF guard)', () => {
  it('flags loopback / private / link-local / internal hosts', () => {
    for (const h of [
      'localhost',
      'foo.local',
      'svc.internal',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it('treats public hosts as non-private', () => {
    for (const h of ['example.com', '1.1.1.1', '8.8.8.8', '172.32.0.1', '193.0.0.1']) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe('isSafePreviewUrl', () => {
  it('allows public http(s) on standard ports', () => {
    expect(isSafePreviewUrl('https://example.com/a')).toBe(true);
    expect(isSafePreviewUrl('http://example.com:80')).toBe(true);
    expect(isSafePreviewUrl('https://a.b.c:443/x')).toBe(true);
  });

  it('rejects private hosts, odd ports, and non-http(s) schemes', () => {
    expect(isSafePreviewUrl('http://localhost/x')).toBe(false);
    expect(isSafePreviewUrl('http://192.168.1.1/x')).toBe(false);
    expect(isSafePreviewUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafePreviewUrl('https://[::1]/x')).toBe(false);
    expect(isSafePreviewUrl('http://example.com:8080/x')).toBe(false); // non-standard port
    expect(isSafePreviewUrl('ftp://example.com/x')).toBe(false);
    expect(isSafePreviewUrl('file:///etc/passwd')).toBe(false);
    expect(isSafePreviewUrl('not a url')).toBe(false);
  });
});
