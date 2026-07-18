import {
  asRecurrence,
  nextOccurrence,
  recurrenceLabel,
  RECURRENCE_VALUES,
} from '@core/schedule';

const DAY = 24 * 60 * 60 * 1000;

/** Local-time epoch ms (monthly math is local-calendar based, so tests build local dates). */
const local = (
  y: number,
  m: number,
  d: number,
  h = 9,
  min = 30,
): number => new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('asRecurrence', () => {
  it('narrows the three valid values and rejects everything else', () => {
    for (const v of RECURRENCE_VALUES) expect(asRecurrence(v)).toBe(v);
    expect(asRecurrence(null)).toBeNull();
    expect(asRecurrence(undefined)).toBeNull();
    expect(asRecurrence('')).toBeNull();
    expect(asRecurrence('yearly')).toBeNull();
    expect(asRecurrence('DAILY')).toBeNull(); // exact-match only (DB stores lowercase)
  });
});

describe('recurrenceLabel', () => {
  it('renders the compact list label', () => {
    expect(recurrenceLabel('daily')).toBe('Repeats daily');
    expect(recurrenceLabel('weekly')).toBe('Repeats weekly');
    expect(recurrenceLabel('monthly')).toBe('Repeats monthly');
  });
});

describe('nextOccurrence — daily/weekly (fixed-ms arithmetic, DST-agnostic by design)', () => {
  it('advances one day when fired on time', () => {
    const at = local(2026, 7, 17);
    expect(nextOccurrence(at, 'daily', at)).toBe(at + DAY);
  });

  it('advances one week when fired on time', () => {
    const at = local(2026, 7, 17);
    expect(nextOccurrence(at, 'weekly', at)).toBe(at + 7 * DAY);
  });

  it('catches up past `now` in ONE jump — a device off for a week does not fire 7 stale dailies', () => {
    const at = local(2026, 7, 10);
    const now = at + 7 * DAY + 5 * 60_000; // woke up 7 days + 5 min later
    const next = nextOccurrence(at, 'daily', now);
    expect(next).toBeGreaterThan(now);
    expect(next).toBe(at + 8 * DAY); // the very next slot, same time-of-day offset
    expect((next - at) % DAY).toBe(0);
  });

  it('weekly catch-up lands on the next weekly slot after now', () => {
    const at = local(2026, 1, 5);
    const now = at + 30 * DAY; // ~4.3 weeks later
    const next = nextOccurrence(at, 'weekly', now);
    expect(next).toBe(at + 35 * DAY);
    expect(next).toBeGreaterThan(now);
  });

  it('is STRICTLY greater than now even when now sits exactly on a slot boundary', () => {
    const at = local(2026, 7, 17);
    const now = at + 3 * DAY; // exactly the 3rd daily slot
    expect(nextOccurrence(at, 'daily', now)).toBe(at + 4 * DAY);
  });
});

describe('nextOccurrence — monthly (calendar math, day-of-month anchored + clamped)', () => {
  it('advances one calendar month keeping day and time-of-day', () => {
    const at = local(2026, 3, 15, 8, 0);
    expect(nextOccurrence(at, 'monthly', at)).toBe(local(2026, 4, 15, 8, 0));
  });

  it('clamps Jan 31 to Feb 28 in a non-leap year', () => {
    const at = local(2026, 1, 31);
    expect(nextOccurrence(at, 'monthly', at)).toBe(local(2026, 2, 28));
  });

  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    const at = local(2024, 1, 31);
    expect(nextOccurrence(at, 'monthly', at)).toBe(local(2024, 2, 29));
  });

  it('anchors to the ORIGINAL day: Jan 31 recurs on Mar 31 (no permanent drift to the 28th)', () => {
    const at = local(2026, 1, 31);
    const afterFeb = local(2026, 3, 1); // now = past the (clamped) Feb 28 slot
    expect(nextOccurrence(at, 'monthly', afterFeb)).toBe(local(2026, 3, 31));
  });

  it('catches up across many missed months (and a year boundary) in one call', () => {
    const at = local(2025, 11, 30);
    const now = local(2026, 7, 17); // ~7.5 months later
    // Slots: Dec 30, Jan 30, Feb 28 (clamp), Mar 30, Apr 30, May 30, Jun 30, Jul 30…
    expect(nextOccurrence(at, 'monthly', now)).toBe(local(2026, 7, 30));
  });
});
