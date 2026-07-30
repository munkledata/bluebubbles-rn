/**
 * `reminderSubtitle` (src/utils/date.ts) — the Reminders-screen subtitle.
 *
 * F14 (device-found): the screen paired `formatChatDate` with `formatTime`, but formatChatDate
 * ALREADY collapses to time-only for today, so a reminder due today rendered its clock twice —
 * "7:45 PM · 7:45 PM". These lock both branches, plus the empty/zero input that formatChatDate
 * maps to "".
 *
 * `now` is injected so the today/not-today split is deterministic rather than depending on when
 * CI happens to run — the whole behaviour under test is that split.
 */
import { formatChatDate, formatTime, reminderSubtitle } from '@utils';

// A fixed local wall-clock reference so "today" vs "later" is unambiguous.
const NOW = new Date(2026, 6, 29, 21, 0, 0).getTime(); // Wed Jul 29 2026, 9:00 PM local

describe('reminderSubtitle', () => {
  it('shows the time ONCE for a reminder due today', () => {
    const dueToday = new Date(2026, 6, 29, 19, 45, 0).getTime();
    const out = reminderSubtitle(dueToday, NOW);

    expect(out).toBe(formatTime(dueToday));
    // The regression itself: no " · " join, and the clock must not appear twice.
    expect(out).not.toContain('·');
    expect(out.split(formatTime(dueToday)).length - 1).toBe(1);
  });

  it('still collapses when the reminder is later today', () => {
    const laterToday = new Date(2026, 6, 29, 23, 30, 0).getTime();
    expect(reminderSubtitle(laterToday, NOW)).toBe(formatTime(laterToday));
  });

  it('joins day and time for a reminder on another day', () => {
    const tomorrow = new Date(2026, 6, 30, 19, 45, 0).getTime();
    const out = reminderSubtitle(tomorrow, NOW);

    expect(out).toBe(`${formatChatDate(tomorrow, NOW)} · ${formatTime(tomorrow)}`);
    expect(out).toContain('·');
  });

  it('joins for a date far enough out that formatChatDate returns a calendar date', () => {
    const nextMonth = new Date(2026, 7, 28, 9, 5, 0).getTime();
    const day = formatChatDate(nextMonth, NOW);
    // Guard the premise: this bucket really is a date label, not a time.
    expect(day).not.toBe(formatTime(nextMonth));
    expect(reminderSubtitle(nextMonth, NOW)).toBe(`${day} · ${formatTime(nextMonth)}`);
  });

  it('falls back to the time alone when formatChatDate yields nothing', () => {
    // formatChatDate maps 0/null to '' — the subtitle must not render a leading " · ".
    expect(reminderSubtitle(0, NOW)).toBe('');
    expect(reminderSubtitle(0, NOW)).not.toContain('·');
  });
});
