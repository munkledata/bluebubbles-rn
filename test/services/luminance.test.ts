/**
 * computeBackgroundIsLight: classifies a wallpaper as light (→ dark overlay text) or dark from
 * its dominant colour, degrading to `null` on any failure. The native colour extractor
 * (`react-native-image-colors`) is mocked in-file; the REAL `relativeLuminance` math runs (routed
 * via requireActual of the node-safe sub-path, so the RN-heavy `@ui/theme` barrel isn't loaded).
 */
const mockGetColors = jest.fn();
jest.mock('react-native-image-colors', () => ({
  __esModule: true,
  default: { getColors: (...args: unknown[]) => mockGetColors(...args) },
}));

// The source imports `relativeLuminance` from the `@ui/theme` barrel, which pulls in RN
// components (ThemeProvider, ThemeStudio) that don't load under the node project — so stub the
// barrel down to just the real luminance fn from its node-safe origin module.
jest.mock('@ui/theme', () => ({
  relativeLuminance: jest.requireActual('@ui/theme/adaptiveFromImage').relativeLuminance,
}));

import { computeBackgroundIsLight } from '@/services/backgrounds/luminance';

beforeEach(() => mockGetColors.mockReset());

describe('computeBackgroundIsLight', () => {
  it('android: a near-white average reads as LIGHT (true)', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      average: '#FFFFFF',
      dominant: '#000000',
    });
    expect(await computeBackgroundIsLight('file:///w.jpg')).toBe(true);
    expect(mockGetColors).toHaveBeenCalledWith('file:///w.jpg', {
      cache: true,
      key: 'file:///w.jpg',
    });
  });

  it('android: a black average reads as DARK (false)', async () => {
    mockGetColors.mockResolvedValue({ platform: 'android', average: '#000000' });
    expect(await computeBackgroundIsLight('x')).toBe(false);
  });

  it('android: falls back to dominant when average is empty', async () => {
    mockGetColors.mockResolvedValue({ platform: 'android', average: '', dominant: '#FFFFFF' });
    expect(await computeBackgroundIsLight('x')).toBe(true);
  });

  it('ios: uses background, falling back to primary', async () => {
    mockGetColors.mockResolvedValue({ platform: 'ios', background: '#FFFFFF', primary: '#000000' });
    expect(await computeBackgroundIsLight('x')).toBe(true);
    mockGetColors.mockResolvedValue({ platform: 'ios', background: '', primary: '#000000' });
    expect(await computeBackgroundIsLight('x')).toBe(false);
  });

  it('unknown platform (default case): uses dominant', async () => {
    mockGetColors.mockResolvedValue({ platform: 'web', dominant: '#FFFFFF' });
    expect(await computeBackgroundIsLight('x')).toBe(true);
  });

  it('returns null when no usable colour is extracted', async () => {
    mockGetColors.mockResolvedValue({ platform: 'android', average: '', dominant: '' });
    expect(await computeBackgroundIsLight('x')).toBeNull();
  });

  it('returns null when the extractor rejects (module not linked / decode error)', async () => {
    mockGetColors.mockRejectedValue(new Error('module not linked'));
    expect(await computeBackgroundIsLight('x')).toBeNull();
  });

  it('returns null (not a crash) when the extracted colour is unparseable', async () => {
    mockGetColors.mockResolvedValue({ platform: 'android', average: 'not-a-hex' });
    expect(await computeBackgroundIsLight('x')).toBeNull();
  });
});
