import {
  contrastRatio,
  generateAdaptiveTokens,
  hexToHsl,
  hslToHex,
  readableTextOn,
  relativeLuminance,
} from '@ui/theme/adaptiveFromImage';
import type { ThemeMode, ThemeTokens } from '@ui/theme/tokens';

const HEX = /^#[0-9A-F]{6}$/;

/** Representative seeds across the hue wheel + extremes (near-grey, near-black, neon). */
const SEEDS: Record<string, string> = {
  blue: '#1982FC',
  red: '#FF3B30',
  nearGrey: '#7E8085',
  yellow: '#FFCC00',
  green: '#34C759',
  purple: '#AF52DE',
  nearBlack: '#0A0A0A',
  neonGreen: '#00FF00',
};

/** Recursively collect every string value in the token tree (all colours). */
function collectColors(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).flatMap(collectColors);
  }
  return [];
}

/** Pull out only the *colour* hex strings (skips font.family = "System"). */
function colorTokens(tokens: ThemeTokens): string[] {
  return collectColors(tokens.color);
}

describe('pure colour helpers', () => {
  it('hexToHsl ↔ hslToHex round-trips primaries within rounding error', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#FF0000');
    expect(hslToHex(120, 1, 0.5)).toBe('#00FF00');
    expect(hslToHex(240, 1, 0.5)).toBe('#0000FF');
    const back = hexToHsl('#1982FC');
    expect(hslToHex(back.h, back.s, back.l)).toBe('#1982FC');
  });

  it('hexToHsl parses #RGB shorthand and #RRGGBB the same', () => {
    expect(hexToHsl('#FFF')).toEqual(hexToHsl('#FFFFFF'));
    expect(hexToHsl('#000')).toEqual(hexToHsl('#000000'));
  });

  it('hslToHex clamps out-of-range s/l and wraps hue', () => {
    expect(HEX.test(hslToHex(720, 5, -1))).toBe(true);
    expect(hslToHex(-360, 0, 0)).toBe('#000000');
  });

  it('relativeLuminance: white = 1, black = 0', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('contrastRatio: black/white is 21:1 and is order-independent', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 4);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 4);
    expect(contrastRatio('#1982FC', '#1982FC')).toBeCloseTo(1, 5);
  });

  it('readableTextOn picks the higher-contrast foreground (white on dark, black on light)', () => {
    const onLight = readableTextOn('#FFFFFF');
    const onDark = readableTextOn('#000000');
    expect(contrastRatio(onLight, '#FFFFFF')).toBeGreaterThan(contrastRatio('#FFFFFF', '#FFFFFF'));
    expect(contrastRatio(onDark, '#000000')).toBeGreaterThan(contrastRatio('#000000', '#000000'));
    // It clears AA on both extremes.
    expect(contrastRatio(onLight, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(onDark, '#000000')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('generateAdaptiveTokens', () => {
  const MODES: ThemeMode[] = ['light', 'dark'];

  it.each(Object.entries(SEEDS))(
    'produces valid #hex for every colour token (%s seed, both modes)',
    (_name, seed) => {
      for (const mode of MODES) {
        const tokens = generateAdaptiveTokens(seed, mode);
        const colors = colorTokens(tokens);
        expect(colors.length).toBeGreaterThan(0);
        for (const c of colors) expect(c).toMatch(HEX);
        expect(tokens.mode).toBe(mode);
        // Structural tokens inherited from the base preset.
        expect(tokens.radius.bubble).toBe(18);
        expect(tokens.spacing.md).toBe(12);
        expect(tokens.font.family).toBe('System');
      }
    },
  );

  it('tint reflects the seed hue (kept, only saturation/lightness normalized)', () => {
    for (const seed of [SEEDS.blue, SEEDS.red, SEEDS.yellow, SEEDS.purple]) {
      const seedHue = hexToHsl(seed!).h;
      const tintHue = hexToHsl(generateAdaptiveTokens(seed!, 'dark').color.tint).h;
      // Hue preserved within a small rounding tolerance.
      const delta = Math.min(Math.abs(seedHue - tintHue), 360 - Math.abs(seedHue - tintHue));
      expect(delta).toBeLessThan(2);
    }
  });

  it('light vs dark differ: light background is bright, dark background is dim', () => {
    for (const seed of Object.values(SEEDS)) {
      const light = generateAdaptiveTokens(seed, 'light');
      const dark = generateAdaptiveTokens(seed, 'dark');
      expect(relativeLuminance(light.color.background)).toBeGreaterThan(0.7);
      expect(relativeLuminance(dark.color.background)).toBeLessThan(0.1);
      expect(light.color.destructive).toBe('#FF3B30');
      expect(dark.color.destructive).toBe('#FF453A');
    }
  });

  it('guarantees readable contrast for sender, label, and received text (all seeds, both modes)', () => {
    for (const [name, seed] of Object.entries(SEEDS)) {
      for (const mode of MODES) {
        const t = generateAdaptiveTokens(seed, mode);
        const senderC = contrastRatio(t.color.bubble.senderText, t.color.bubble.senderBackground);
        const labelC = contrastRatio(t.color.label, t.color.background);
        const recvC = contrastRatio(
          t.color.bubble.receivedText,
          t.color.bubble.receivedBackgroundTop,
        );
        expect(senderC).toBeGreaterThanOrEqual(4.5);
        expect(labelC).toBeGreaterThanOrEqual(4.5);
        expect(recvC).toBeGreaterThanOrEqual(4);
        // Surface a helpful message if any assertion ever regresses.
        if (senderC < 4.5 || labelC < 4.5 || recvC < 4) {
          throw new Error(`contrast regression for ${name}/${mode}`);
        }
      }
    }
  });

  // The handful of fixed seeds above happen to dodge the high-saturation "dead zone"
  // (L ≈ 0.45–0.60) where neither near-white nor near-black clears AA on the raw tint.
  // This exhaustive sweep is the real guarantee: for EVERY hue, at high saturation,
  // across the lightness band normalizeTint clamps into, the sender text MUST clear
  // 4.5 on the (tint-as-)senderBackground. It catches the regression the fixed seeds
  // masked, while the label/received contrast still holds for every generated theme.
  it('AA sender contrast holds across an exhaustive hue sweep at high saturation', () => {
    let worstSender = Infinity;
    let worstAt = '';
    for (let h = 0; h < 360; h += 1) {
      // Walk the lightness band normalizeTint clamps into (0.40–0.62), at saturations
      // spanning its clamp range, so the high-S dead zone is fully exercised.
      for (const s of [0.35, 0.5, 0.7, 0.85, 1.0]) {
        for (let l = 0.4; l <= 0.621; l += 0.02) {
          const seed = hslToHex(h, s, l);
          for (const mode of MODES) {
            const t = generateAdaptiveTokens(seed, mode);
            const senderC = contrastRatio(
              t.color.bubble.senderText,
              t.color.bubble.senderBackground,
            );
            const labelC = contrastRatio(t.color.label, t.color.background);
            const recvC = contrastRatio(
              t.color.bubble.receivedText,
              t.color.bubble.receivedBackgroundTop,
            );
            if (senderC < worstSender) {
              worstSender = senderC;
              worstAt = `h=${h} s=${s} l=${l.toFixed(2)} ${mode} tint=${t.color.bubble.senderBackground}`;
            }
            expect(labelC).toBeGreaterThanOrEqual(4.5);
            expect(recvC).toBeGreaterThanOrEqual(4);
          }
        }
      }
    }
    // The whole point: NOT a single (hue, S, L) combination drops below AA.
    expect(worstSender).toBeGreaterThanOrEqual(4.5);
    if (worstSender < 4.5) throw new Error(`sender contrast dead zone at ${worstAt}`);
  });
});
