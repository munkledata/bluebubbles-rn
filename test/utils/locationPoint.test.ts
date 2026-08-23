import { HIDDEN_POINT, hasCoordinates, resolveDisplayPoint } from '@utils';

// A high-entropy pair makes rounded, swapped, or substituted coordinates observable.
const LAT = 43.847291;
const LNG = -79.418533;

describe('finite coordinate utilities', () => {
  it('returns the exact finite point', () => {
    expect(resolveDisplayPoint(LAT, LNG)).toEqual({
      visible: true,
      latitude: LAT,
      longitude: LNG,
    });
  });

  it.each([
    ['missing latitude', null, LNG],
    ['missing longitude', LAT, null],
    ['both undefined', undefined, undefined],
    ['NaN latitude', Number.NaN, LNG],
    ['infinite longitude', LAT, Number.POSITIVE_INFINITY],
  ])('withholds a %s without exposing numeric fields', (_label, latitude, longitude) => {
    const point = resolveDisplayPoint(latitude, longitude);
    expect(point).toBe(HIDDEN_POINT);
    expect(Object.keys(point)).toEqual(['visible']);
    expect(JSON.stringify(point)).toBe('{"visible":false}');
    expect(JSON.stringify(point)).not.toMatch(/\d/);
  });

  it('reports only complete finite coordinate pairs as locatable', () => {
    expect(hasCoordinates(LAT, LNG)).toBe(true);
    expect(hasCoordinates(0, 0)).toBe(true);
    expect(hasCoordinates(null, LNG)).toBe(false);
    expect(hasCoordinates(LAT, null)).toBe(false);
    expect(hasCoordinates(undefined, undefined)).toBe(false);
    expect(hasCoordinates(Number.NaN, LNG)).toBe(false);
    expect(hasCoordinates(LAT, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
