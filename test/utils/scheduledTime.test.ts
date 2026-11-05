/**
 * `formatScheduledTime` (src/utils/date.ts) — the time label for scheduled messages and reminders.
 *
 * Device-found: the scheduled-message editor paired formatChatDate with formatTime. formatChatDate
 * is for PAST timestamps, so today's send showed its clock twice ("11:30 PM 11:30 PM") and any
 * future date became a bare weekday ("Sunday" for a message months away). Reminders used the same
 * pairing (de-duplicated, but still a weekday for any future date).
 *
 * `now` is injected so every bucket is deterministic.
 */
import { formatScheduledTime, formatTime } from '@utils';

// Wed Jul 29 2026, 9:00 PM local.
const NOW = new Date(2026, 6, 29, 21, 0, 0).getTime();
const at = (month: number, day: number, hour = 9, minute = 0, year = 2026): number =>
  new Date(year, month, day, hour, minute, 0).getTime();

describe('formatScheduledTime', () => {
  it('shows the clock ONCE for today, with the day named', () => {
    const later = at(6, 29, 23, 30);
    expect(formatScheduledTime(later, NOW)).toBe(`Today ${formatTime(later)}`);
    expect(formatScheduledTime(later, NOW).split(formatTime(later)).length - 1).toBe(1);
  });

  it('names tomorrow and yesterday', () => {
    expect(formatScheduledTime(at(6, 30), NOW)).toBe(`Tomorrow ${formatTime(at(6, 30))}`);
    expect(formatScheduledTime(at(6, 28), NOW)).toBe(`Yesterday ${formatTime(at(6, 28))}`);
  });

  it('uses the weekday only within the next six days', () => {
    const friday = at(6, 31);
    expect(formatScheduledTime(friday, NOW)).toBe(`Friday ${formatTime(friday)}`);
    // Seven days out is the same weekday as today, so it gets a date instead.
    expect(formatScheduledTime(at(7, 5), NOW)).toBe(`Aug 5, ${formatTime(at(7, 5))}`);
  });

  it('gives a real date for anything further out, with the year when it differs', () => {
    expect(formatScheduledTime(at(9, 4), NOW)).toBe(`Oct 4, ${formatTime(at(9, 4))}`);
    const nextYear = at(2, 3, 9, 0, 2027);
    expect(formatScheduledTime(nextYear, NOW)).toBe(`Mar 3, 2027, ${formatTime(nextYear)}`);
  });

  it('dates a moment that passed more than a day ago', () => {
    expect(formatScheduledTime(at(6, 20), NOW)).toBe(`Jul 20, ${formatTime(at(6, 20))}`);
  });
});
