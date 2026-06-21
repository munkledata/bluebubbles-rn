import { compareVersions, isAtLeast } from '@utils/version';

describe('version compare', () => {
  it('orders dotted-numeric versions', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.9.0')).toBe(0);
  });

  it('zero-pads differing segment counts', () => {
    expect(compareVersions('1.9', '1.9.0')).toBe(0);
    expect(compareVersions('1.9.1', '1.9')).toBe(1);
  });

  it('tolerates a leading v and stray text', () => {
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
  });

  it('isAtLeast gates the min server version', () => {
    expect(isAtLeast('1.9.5', '1.9.0')).toBe(true);
    expect(isAtLeast('1.8.9', '1.9.0')).toBe(false);
  });
});
