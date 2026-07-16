import {
  adaptiveTokensFromImage,
  generateAdaptiveTokens,
  hexToHsl,
  relativeLuminance,
} from '@ui/theme/adaptiveFromImage';
import type { ThemeMode } from '@ui/theme/tokens';

/** Controllable stand-in for the lazily-imported native colour extractor. */
const mockGetColors = jest.fn();
jest.mock('react-native-image-colors', () => ({
  __esModule: true,
  default: {
    getColors: (...args: unknown[]) => mockGetColors(...args),
  },
}));

const SEED_FALLBACK = '#1982FC';

beforeEach(() => {
  mockGetColors.mockReset();
});

// ---- parseHex error branch (source line 32) --------------------------------

describe('parseHex throw branch (via public helpers)', () => {
  it('hexToHsl throws on an unparseable hex string', () => {
    expect(() => hexToHsl('#GGGGGG')).toThrow(/invalid hex color/);
    expect(() => hexToHsl('nonsense')).toThrow(/invalid hex color/);
    expect(() => hexToHsl('#12')).toThrow(/invalid hex color/); // length 2, not 3 or 6
  });

  it('relativeLuminance throws on an unparseable hex string', () => {
    expect(() => relativeLuminance('#XYZ')).toThrow(/invalid hex color/);
  });
});

// ---- adaptiveTokensFromImage native bridge (source lines 273-299) ----------

describe('adaptiveTokensFromImage', () => {
  it('passes the uri + fallback/cache/key config to the extractor', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      vibrant: '#34C759',
      dominant: '#111111',
    });
    await adaptiveTokensFromImage('file:///pic.jpg', 'light');
    expect(mockGetColors).toHaveBeenCalledWith('file:///pic.jpg', {
      fallback: SEED_FALLBACK,
      cache: true,
      key: 'file:///pic.jpg',
    });
  });

  it('android + dark: prefers darkVibrant as the seed', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      darkVibrant: '#8B0000',
      vibrant: '#FF0000',
      dominant: '#00FF00',
    });
    const tokens = await adaptiveTokensFromImage('x', 'dark');
    expect(tokens).toEqual(generateAdaptiveTokens('#8B0000', 'dark'));
  });

  it('android + dark: falls back darkVibrant → vibrant → dominant', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      darkVibrant: '',
      vibrant: '',
      dominant: '#00FF00',
    });
    const tokens = await adaptiveTokensFromImage('x', 'dark');
    expect(tokens).toEqual(generateAdaptiveTokens('#00FF00', 'dark'));
  });

  it('android + light: prefers vibrant, then dominant', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      darkVibrant: '#8B0000',
      vibrant: '#FF00FF',
      dominant: '#00FF00',
    });
    const tokens = await adaptiveTokensFromImage('x', 'light');
    // darkVibrant ignored in light mode; vibrant wins.
    expect(tokens).toEqual(generateAdaptiveTokens('#FF00FF', 'light'));
  });

  it('ios: uses primary, then detail', async () => {
    mockGetColors.mockResolvedValue({ platform: 'ios', primary: '#123456', detail: '#654321' });
    expect(await adaptiveTokensFromImage('x', 'light')).toEqual(
      generateAdaptiveTokens('#123456', 'light'),
    );

    mockGetColors.mockResolvedValue({ platform: 'ios', primary: '', detail: '#654321' });
    expect(await adaptiveTokensFromImage('x', 'dark')).toEqual(
      generateAdaptiveTokens('#654321', 'dark'),
    );
  });

  it('unknown platform (default case): uses vibrant, then dominant', async () => {
    mockGetColors.mockResolvedValue({ platform: 'web', vibrant: '#AABBCC', dominant: '#DDEEFF' });
    expect(await adaptiveTokensFromImage('x', 'light')).toEqual(
      generateAdaptiveTokens('#AABBCC', 'light'),
    );

    mockGetColors.mockResolvedValue({ platform: 'web', vibrant: undefined, dominant: '#DDEEFF' });
    expect(await adaptiveTokensFromImage('x', 'light')).toEqual(
      generateAdaptiveTokens('#DDEEFF', 'light'),
    );
  });

  it('empty extracted seed falls back to SEED_FALLBACK', async () => {
    mockGetColors.mockResolvedValue({
      platform: 'android',
      darkVibrant: '',
      vibrant: '',
      dominant: '',
    });
    const tokens = await adaptiveTokensFromImage('x', 'dark');
    expect(tokens).toEqual(generateAdaptiveTokens(SEED_FALLBACK, 'dark'));
  });

  it('returns null when the extractor rejects (native failure degrades gracefully)', async () => {
    mockGetColors.mockRejectedValue(new Error('module not linked'));
    expect(await adaptiveTokensFromImage('x', 'light')).toBeNull();
  });

  it.each<ThemeMode>(['light', 'dark'])(
    'produces a fully-valid token set for a real extracted seed (%s)',
    async (mode) => {
      mockGetColors.mockResolvedValue({
        platform: 'android',
        vibrant: '#AF52DE',
        dominant: '#AF52DE',
      });
      const tokens = await adaptiveTokensFromImage('x', mode);
      expect(tokens).not.toBeNull();
      expect(tokens!.mode).toBe(mode);
      expect(tokens!.color.tint).toMatch(/^#[0-9A-F]{6}$/);
    },
  );
});
