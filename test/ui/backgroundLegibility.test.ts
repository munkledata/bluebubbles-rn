import { withAlpha } from '@ui/theme/tokens';
import { overlayPillStyle, overlayTextStyle } from '@ui/conversations/overlayText';
import { edgeFadeStops } from '@ui/conversations/edgeFadeStops';

describe('withAlpha', () => {
  it('converts #RRGGBB to rgba() at the given alpha', () => {
    expect(withAlpha('#0B1A2B', 0.6)).toBe('rgba(11, 26, 43, 0.6)');
    expect(withAlpha('#FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
  });

  it('expands #RGB shorthand and clamps out-of-range alpha', () => {
    expect(withAlpha('#abc', 0.5)).toBe('rgba(170, 187, 204, 0.5)');
    expect(withAlpha('#0B1A2B', 2)).toBe('rgba(11, 26, 43, 1)');
    expect(withAlpha('#0B1A2B', -1)).toBe('rgba(11, 26, 43, 0)');
  });

  it('returns the input unchanged for a non-hex value', () => {
    expect(withAlpha('rgba(1,2,3,0.5)', 0.6)).toBe('rgba(1,2,3,0.5)');
    expect(withAlpha('nope', 0.6)).toBe('nope');
  });
});

describe('overlayTextStyle', () => {
  const GRAY = '#8E8E93';
  const LABEL = '#000000';

  it('no background → the muted fallback colour, not bold', () => {
    expect(overlayTextStyle(false, GRAY, LABEL)).toEqual({ color: GRAY });
    expect(overlayTextStyle(undefined, GRAY, LABEL)).toEqual({ color: GRAY });
  });

  it('background → the theme label colour (contrast comes from the pill), semibold', () => {
    expect(overlayTextStyle(true, GRAY, LABEL)).toEqual({ color: LABEL, fontWeight: '600' });
  });
});

describe('overlayPillStyle', () => {
  const BG = '#1C1C1E';

  it('no background → null (labels stay unbacked)', () => {
    expect(overlayPillStyle(false, BG)).toBeNull();
    expect(overlayPillStyle(undefined, BG)).toBeNull();
  });

  it('background → a frosted pill tinted with the theme background at 62%', () => {
    const pill = overlayPillStyle(true, BG);
    expect(pill).not.toBeNull();
    expect(pill!.backgroundColor).toBe(withAlpha(BG, 0.62));
    expect(pill!.borderRadius).toBeGreaterThan(0);
    expect(pill!.paddingHorizontal).toBeGreaterThan(0);
    expect(pill!.overflow).toBe('hidden');
  });
});

describe('edgeFadeStops', () => {
  const BG = '#FFFFFF';

  it('holds near-opaque through the bar zone, then dissolves to alpha 0', () => {
    const stops = edgeFadeStops(BG, 0.7);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toEqual({ color: 'rgba(255, 255, 255, 0.88)', positions: ['0%'] });
    expect(stops[1]).toEqual({ color: 'rgba(255, 255, 255, 0.8)', positions: ['70%'] });
    // Fades to the SAME colour at alpha 0 — 'transparent' (black@0) would leave a dark fringe.
    expect(stops[2]).toEqual({ color: 'rgba(255, 255, 255, 0)', positions: ['100%'] });
  });

  it('clamps the hold fraction into 0..1', () => {
    expect(edgeFadeStops(BG, -0.5)[1]!.positions).toEqual(['0%']);
    expect(edgeFadeStops(BG, 1.7)[1]!.positions).toEqual(['100%']);
  });
});
