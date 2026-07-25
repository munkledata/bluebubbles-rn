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

  /**
   * REGRESSION: an IPv4-mapped IPv6 host walked straight through this guard. The suite tested
   * `::1` / `fe80::1` / `fd00::1`, which READS like IPv6 is covered — but `[::ffff:127.0.0.1]`
   * matched none of them and `isPrivateHost` returned false, so a link in a received message
   * could make the app fetch its own loopback (or the cloud-metadata address).
   *
   * Both spellings are asserted on purpose: a spec-compliant URL parser normalizes the dotted
   * form to hex, but React Native ships its own URL implementation, so the dotted form can
   * reach this function on device even though Node never produces it here.
   */
  it('flags IPv4-mapped IPv6 loopback/private/metadata in BOTH the hex and dotted spellings', () => {
    for (const h of [
      '::ffff:7f00:1', // hex   127.0.0.1  (what new URL() produces)
      '::ffff:127.0.0.1', // dotted 127.0.0.1
      '[::ffff:127.0.0.1]', // bracketed, as a hostname may arrive
      '::ffff:a9fe:a9fe', // hex   169.254.169.254 (cloud metadata)
      '::ffff:169.254.169.254',
      '::ffff:c0a8:1', // hex   192.168.0.1
      '::ffff:192.168.1.10',
      '::ffff:0a00:5', // hex   10.0.0.5
      '::ffff:0:127.0.0.1', // IPv4-translated variant
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it('does not over-block a PUBLIC IPv4-mapped address', () => {
    expect(isPrivateHost('::ffff:0808:0808')).toBe(false); // 8.8.8.8
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateHost('2606:4700::1111')).toBe(false); // ordinary public IPv6
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

  it('rejects the IPv4-mapped IPv6 bypass end-to-end', () => {
    expect(isSafePreviewUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isSafePreviewUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).toBe(false);
    expect(isSafePreviewUrl('https://[::ffff:192.168.1.1]/x')).toBe(false);
  });

  /**
   * These numeric spellings all normalize to 127.0.0.1 in the URL parser rather than in
   * `isPrivateHost`. Pinned so a future hand-rolled host parser can't silently reopen them.
   */
  it('rejects decimal/hex/octal/short-form spellings of loopback', () => {
    for (const u of [
      'http://2130706433/', // decimal
      'http://0x7f000001/', // hex
      'http://017700000001/', // octal
      'http://127.1/', // short form
      'http://127.0.0.1./', // trailing dot
      'http://example.com@127.0.0.1/', // userinfo confusion
    ]) {
      expect(isSafePreviewUrl(u)).toBe(false);
    }
  });
});
