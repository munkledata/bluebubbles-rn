import { edgeFadeStops } from '@ui/conversations/edgeFadeStops';
import { withAlpha } from '@ui/theme/tokens';

describe('edgeFadeStops', () => {
  it('is strongest at the edge, holds through the bar zone, then dissolves to the same colour at alpha 0', () => {
    expect(edgeFadeStops('#0B1A2B', 0.4)).toEqual([
      { color: withAlpha('#0B1A2B', 0.88), positions: ['0%'] },
      { color: withAlpha('#0B1A2B', 0.8), positions: ['40%'] },
      { color: withAlpha('#0B1A2B', 0), positions: ['100%'] },
    ]);
  });

  it('never fades through black: the last stop keeps the theme colour', () => {
    const last = edgeFadeStops('#FFFFFF', 0.5).at(-1)!;
    expect(last.color).toBe(withAlpha('#FFFFFF', 0));
    expect(last.color).not.toBe('transparent');
  });

  it.each([
    [-1, '0%'],
    [0, '0%'],
    [0.333, '33%'],
    [1, '100%'],
    [2, '100%'],
  ])('clamps and rounds a hold fraction of %p to %s', (fraction, position) => {
    expect(edgeFadeStops('#000000', fraction)[1]!.positions).toEqual([position]);
  });
});
