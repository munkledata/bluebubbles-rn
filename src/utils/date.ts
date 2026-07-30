/**
 * Relative timestamp for the conversation list, ported from the Flutter
 * `buildDate()` Cupertino branch. Thresholds (calendar-day based):
 *   - null/0            -> ""
 *   - same day          -> time only ("2:14 PM")
 *   - exactly yesterday -> "Yesterday"
 *   - within 7 days     -> weekday name ("Monday")
 *   - same year         -> "Jan 15"
 *   - earlier years     -> "1/15/24"
 */
export function formatChatDate(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms == null || ms === 0) return '';
  const d = new Date(ms);
  const today = new Date(now);

  if (isSameDay(today, d)) return timeOnly(d);
  const days = calendarDaysBetween(d, today);
  if (days === 1) return 'Yesterday';
  if (days <= 7) return weekday(d);
  if (today.getFullYear() === d.getFullYear()) return monthDay(d);
  return shortDate(d);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole calendar days between an earlier date and `today` (both local midnight). */
function calendarDaysBetween(earlier: Date, today: Date): number {
  const a = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((b - a) / 86_400_000);
}

function timeOnly(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Time-only label (e.g. "2:14 PM") for status lines and date separators. */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return '';
  return timeOnly(new Date(ms));
}

/** Full date + time for a conversation date separator (e.g. "Mon, Jan 5, 2:14 PM"). */
export function formatSeparatorDate(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (ms == null || ms === 0) return '';
  const d = new Date(ms);
  if (isSameDay(new Date(now), d)) return `Today ${timeOnly(d)}`;
  const datePart = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
  return `${datePart}, ${timeOnly(d)}`;
}
function weekday(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(d);
}
function monthDay(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
}
function shortDate(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

/**
 * Subtitle for a saved message reminder: "7:45 PM" when it's due TODAY, "Thu, Jul 30 · 7:45 PM"
 * otherwise.
 *
 * {@link formatChatDate} already collapses to time-only for today, so naively pairing it with
 * {@link formatTime} rendered the same clock TWICE ("7:45 PM · 7:45 PM") — seen on device on the
 * Reminders screen. The de-dupe compares the two RENDERED strings rather than re-deriving "is it
 * today", so it stays correct if formatChatDate's bucketing thresholds ever change.
 *
 * `now` is injectable so this is deterministic under test (the today/not-today branch is the
 * entire point of the function).
 */
export function reminderSubtitle(scheduledFor: number, now: number = Date.now()): string {
  const day = formatChatDate(scheduledFor, now);
  const time = formatTime(scheduledFor);
  return day === time || day === '' ? time : `${day} · ${time}`;
}
