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

/** Whether two moments fall on the same local calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
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

/**
 * A scheduled moment (a scheduled message or a reminder), usually in the FUTURE:
 * "Today 11:30 PM", "Tomorrow 9:00 AM", "Sunday 9:00 AM" within the next six days,
 * "Mar 3, 9:00 AM" later this year and "Mar 3, 2027, 9:00 AM" in another year. A moment that has
 * passed reads "Yesterday 9:00 AM" or its date. formatChatDate is for PAST timestamps: it turned
 * every future date into a weekday name, so a message months away read "Sunday", and pairing it
 * with formatTime showed today's clock twice.
 *
 * `now` is injectable so this is deterministic under test.
 */
export function formatScheduledTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const time = timeOnly(d);
  const daysAhead = calendarDaysBetween(today, d);
  if (daysAhead === 0) return `Today ${time}`;
  if (daysAhead === 1) return `Tomorrow ${time}`;
  if (daysAhead === -1) return `Yesterday ${time}`;
  if (daysAhead > 1 && daysAhead < 7) return `${weekday(d)} ${time}`;
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  }).format(d);
  return `${date}, ${time}`;
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
