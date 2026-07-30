import {
  HIDDEN_POINT,
  hasCoordinates,
  redactBatteryPercent,
  redactLabel,
  redactLocationDetail,
  redactMessageText,
  redactPreview,
  redactTitle,
  resolveDisplayPoint,
} from '@utils';

// A real-looking pair whose digit groups ('43.84', '79.41') cannot plausibly appear as a style
// value, font size or theme token — so an assertion on them genuinely bites.
const LAT = 43.847291;
const LNG = -79.418533;

describe('privacy redaction helpers', () => {
  it('pass through unchanged when not redacted', () => {
    expect(redactPreview('hi there', false)).toBe('hi there');
    expect(redactTitle('Craig', false)).toBe('Craig');
    expect(redactMessageText('secret', false)).toBe('secret');
  });

  it('mask content with generic placeholders when redacted', () => {
    expect(redactPreview('hi there', true)).toBe('Message');
    expect(redactTitle('Craig', true)).toBe('Contact');
    expect(redactMessageText('secret', true)).toBe('Message');
  });

  it('preserve empty/null so layout does not shift', () => {
    expect(redactPreview('', true)).toBe('');
    expect(redactTitle('', true)).toBe('');
    expect(redactMessageText(null, true)).toBe('');
    expect(redactMessageText(undefined, false)).toBe('');
  });
});

describe('redactLabel', () => {
  it('swaps in the placeholder only when redacted', () => {
    expect(redactLabel('Craig’s iPhone', 'Device', true)).toBe('Device');
    expect(redactLabel('Craig’s iPhone', 'Device', false)).toBe('Craig’s iPhone');
    expect(redactLabel('', 'Device', true)).toBe('');
  });
});

describe('resolveDisplayPoint', () => {
  it('returns the real coordinates when not redacted', () => {
    expect(resolveDisplayPoint(LAT, LNG, false)).toEqual({
      visible: true,
      latitude: LAT,
      longitude: LNG,
    });
  });

  // THE KEY ASSERTION. A decoy point, a coarsened value or a rounded one would all still contain
  // digits; withholding entirely is the only thing that satisfies this.
  it('yields a result containing no digit at all when redacted', () => {
    const pt = resolveDisplayPoint(LAT, LNG, true);
    expect(pt).toEqual({ visible: false });
    expect(JSON.stringify(pt)).not.toMatch(/\d/);
  });

  it('exposes no coordinate keys to read accidentally when redacted', () => {
    expect(Object.keys(resolveDisplayPoint(LAT, LNG, true))).toEqual(['visible']);
  });

  // A half-located device must never plot at (0, 0) — that points at the Gulf of Guinea.
  it.each([
    ['null lat', null, LNG],
    ['null lng', LAT, null],
    ['undefined', undefined, undefined],
    ['NaN', Number.NaN, LNG],
    ['Infinity', LAT, Number.POSITIVE_INFINITY],
  ])('hides a non-finite pair (%s) in both modes', (_label, lat, lng) => {
    expect(resolveDisplayPoint(lat, lng, false)).toEqual({ visible: false });
    expect(resolveDisplayPoint(lat, lng, true)).toEqual({ visible: false });
  });

  it('is deterministic, and the redacted result is referentially stable', () => {
    expect(resolveDisplayPoint(LAT, LNG, false)).toEqual(resolveDisplayPoint(LAT, LNG, false));
    expect(resolveDisplayPoint(LAT, LNG, true)).toBe(HIDDEN_POINT);
  });
});

describe('hasCoordinates', () => {
  it('reports locatability regardless of redaction (it is not identifying)', () => {
    expect(hasCoordinates(LAT, LNG)).toBe(true);
    expect(hasCoordinates(null, LNG)).toBe(false);
    expect(hasCoordinates(Number.NaN, LNG)).toBe(false);
  });
});

describe('redactLocationDetail', () => {
  it('drops a reverse-geocoded street address when redacted', () => {
    const addr = '1 Infinite Loop, Cupertino';
    expect(redactLocationDetail(addr, true, true)).toBe('Location available');
    expect(redactLocationDetail(addr, true, true)).not.toContain('Cupertino');
  });

  it('passes the address through when not redacted, falling back on copy', () => {
    expect(redactLocationDetail('1 Infinite Loop', true, false)).toBe('1 Infinite Loop');
    expect(redactLocationDetail(null, true, false)).toBe('Location available');
    expect(redactLocationDetail(null, false, false)).toBe('No location');
    expect(redactLocationDetail(null, false, true)).toBe('No location');
  });
});

describe('redactBatteryPercent', () => {
  it('drops battery entirely when redacted (it correlates a physical device)', () => {
    expect(redactBatteryPercent(0.63, true)).toBeNull();
  });

  it('rounds to a whole percent otherwise, and tolerates missing values', () => {
    expect(redactBatteryPercent(0.63, false)).toBe(63);
    expect(redactBatteryPercent(null, false)).toBeNull();
    expect(redactBatteryPercent(undefined, false)).toBeNull();
  });
});
