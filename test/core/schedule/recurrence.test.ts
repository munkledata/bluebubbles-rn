import { asRecurrence, nextOccurrence, recurrenceLabel, RECURRENCE_VALUES } from '@core/schedule';

const DAY = 24 * 60 * 60 * 1000;

/** Local-time epoch ms (monthly math is local-calendar based, so tests build local dates). */
const local = (y: number, m: number, d: number, h = 9, min = 30): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

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

describe('nextOccurrence — daily/weekly (whole local days)', () => {
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

// jest.config.js pins TZ=America/Denver: clocks jump forward on 2026-03-08 and back on 2026-11-01.
describe('nextOccurrence — daily/weekly across a DST change (keeps the wall-clock time)', () => {
  it('daily: the slot after the spring-forward night is still 09:00 (a 23-hour day)', () => {
    const at = local(2026, 3, 7, 9, 0);
    const next = nextOccurrence(at, 'daily', at + 60 * 60_000);
    expect(next).toBe(local(2026, 3, 8, 9, 0));
    expect(new Date(next).getHours()).toBe(9);
    expect(next - at).toBe(23 * 60 * 60_000);
  });

  it('daily: the slot after the fall-back night is still 09:00 (a 25-hour day)', () => {
    const at = local(2026, 10, 31, 9, 0);
    const next = nextOccurrence(at, 'daily', at + 60 * 60_000);
    expect(next).toBe(local(2026, 11, 1, 9, 0));
    expect(new Date(next).getHours()).toBe(9);
    expect(next - at).toBe(25 * 60 * 60_000);
  });

  it('weekly: a week that contains the DST change keeps 09:00', () => {
    const at = local(2026, 3, 1, 9, 0);
    const next = nextOccurrence(at, 'weekly', at + DAY);
    expect(next).toBe(local(2026, 3, 8, 9, 0));
    expect(new Date(next).getHours()).toBe(9);
  });

  it('catch-up across the DST change lands on the next 09:00 slot after now, strictly later', () => {
    const at = local(2026, 3, 1, 9, 0);
    const now = local(2026, 3, 20, 10, 0); // 19 days later, after the clocks moved
    const next = nextOccurrence(at, 'daily', now);
    expect(next).toBe(local(2026, 3, 21, 9, 0));
    expect(next).toBeGreaterThan(now);
    // now exactly on a slot: still strictly later
    expect(nextOccurrence(at, 'daily', local(2026, 3, 21, 9, 0))).toBe(local(2026, 3, 22, 9, 0));
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
