/**
 * Scheduled-message recurrence (React-free; runs in Node tests + the headless worker).
 *
 * Deliberately boring: three fixed cadences, no rrule library.
 * - daily/weekly advance by whole LOCAL calendar days (1 or 7), so the anchor's wall-clock
 *   time survives a DST change: a 9:00 message stays at 9:00 instead of drifting to 8:00 or
 *   10:00 for the rest of the year (fixed 24 h steps did exactly that).
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

/** `anchorMs` shifted by whole local days, keeping the anchor's wall-clock time across DST. */
function addDaysLocal(anchorMs: number, days: number): number {
  const d = new Date(anchorMs);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

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
  const stepDays = recurrence === 'daily' ? 1 : 7;
  // Estimate the missed steps from fixed milliseconds (one jump, so a device that was off for
  // weeks does no per-day loop), then correct by calendar steps: a DST hour can put the estimate
  // one step high or low, never more. The result must be STRICTLY after `now`.
  let steps = Math.max(0, Math.floor((nowMs - scheduledAtMs) / (stepDays * DAY_MS)));
  let next = addDaysLocal(scheduledAtMs, (steps + 1) * stepDays);
  while (next <= nowMs) {
    steps += 1;
    next = addDaysLocal(scheduledAtMs, (steps + 1) * stepDays);
  }
  while (steps > 0 && addDaysLocal(scheduledAtMs, steps * stepDays) > nowMs) {
    steps -= 1;
    next = addDaysLocal(scheduledAtMs, (steps + 1) * stepDays);
  }
  return next;
}
