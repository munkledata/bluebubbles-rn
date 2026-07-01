import { isFaceTimeLink } from '@core/facetime';

describe('isFaceTimeLink', () => {
  it('accepts Apple FaceTime https join links', () => {
    expect(isFaceTimeLink('https://facetime.apple.com/join#v=1&p=abc&k=def')).toBe(true);
  });

  it('accepts the facetime: scheme, case-insensitively', () => {
    expect(isFaceTimeLink('facetime://call?id=1')).toBe(true);
    expect(isFaceTimeLink('FaceTime:foo')).toBe(true);
    expect(isFaceTimeLink('HTTPS://FaceTime.Apple.com/join#x')).toBe(true);
  });

  it('rejects nullish/empty input', () => {
    expect(isFaceTimeLink(null)).toBe(false);
    expect(isFaceTimeLink(undefined)).toBe(false);
    expect(isFaceTimeLink('')).toBe(false);
  });

  it('rejects arbitrary schemes a compromised server might return', () => {
    expect(isFaceTimeLink('intent://evil#Intent;scheme=foo;end')).toBe(false);
    expect(isFaceTimeLink('tel:+15551234567')).toBe(false);
    expect(isFaceTimeLink('javascript:alert(1)')).toBe(false);
  });

  it('rejects look-alike hosts and non-https FaceTime URLs', () => {
    expect(isFaceTimeLink('https://facetime.apple.com.evil.com/join')).toBe(false);
    expect(isFaceTimeLink('https://evil.com/facetime.apple.com')).toBe(false);
    expect(isFaceTimeLink('http://facetime.apple.com/join')).toBe(false);
  });
});
