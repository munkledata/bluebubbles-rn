/**
 * Scheduled-message recurrence (React-free; runs in Node tests + the headless worker).
 *
 * Deliberately boring: three fixed cadences, no rrule library.
 * - daily/weekly advance by FIXED milliseconds (24h / 7×24h). This is DST-agnostic by
 *   design: across a DST boundary the local wall-clock time shifts by an hour, which we
 *   accept for simplicity (documented trade-off).
 * - monthly uses CALENDAR math anchored to the ORIGINAL day-of-month, clamping to each
 *   target month's last day. Jan 31 → Feb 28 (29 in a leap year) → Mar 31 — the clamp is
 *   per-occurrence, so the day does NOT permanently drift down to the 28th.
 */

export type Recurrence = 'daily' | 'weekly' | 'monthly';

export const RECURRENCE_VALUES: readonly Recurrence[] = ['daily', 'weekly', 'monthly'];

/** Narrow a DB string (nullable TEXT column) to a Recurrence, else null (one-shot). */
export function asRecurrence(value: string | null | undefined): Recurrence | null {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : null;
}

/** Compact UI label for a recurring row, e.g. "Repeats daily". */
export function recurrenceLabel(recurrence: Recurrence): string {
  return `Repeats ${recurrence}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `anchorMs` shifted forward by `months` calendar months, keeping the anchor's local
 * time-of-day and clamping the anchor's day-of-month to the target month's length.
 */
function addMonthsClamped(anchorMs: number, months: number): number {
  const anchor = new Date(anchorMs);
  const target = new Date(anchorMs);
  // Move to the 1st BEFORE changing the month so e.g. Jan 31 + 1mo can't overflow to Mar 3.
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(anchor.getDate(), daysInTarget));
  return target.getTime();
}

/**
 * The next fire time STRICTLY after `nowMs`, advancing from `scheduledAtMs` by the given
 * cadence as many steps as needed. The catch-up loop means a device that was off for a
 * week re-arms a daily message ONCE at tomorrow's slot — it does not fire 7 stale sends.
 */
export function nextOccurrence(
  scheduledAtMs: number,
  recurrence: Recurrence,
  nowMs: number,
): number {
  if (recurrence === 'monthly') {
    let months = 1;
    let next = addMonthsClamped(scheduledAtMs, months);
    while (next <= nowMs) {
      months += 1;
      next = addMonthsClamped(scheduledAtMs, months);
    }
    return next;
  }
  const step = recurrence === 'daily' ? DAY_MS : 7 * DAY_MS;
  // Jump straight past `now` (no per-step loop needed for a fixed-ms cadence).
  const missed = Math.max(0, Math.floor((nowMs - scheduledAtMs) / step));
  let next = scheduledAtMs + (missed + 1) * step;
  if (next <= nowMs) next += step; // exact-boundary guard: result must be STRICTLY > now
  return next;
}
