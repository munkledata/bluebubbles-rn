const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "Updated 5 min ago" for a Find My location time (epoch ms). Recent times read relatively; older
 * ones show the date. A time slightly in the future (the Mac's clock ahead of the phone's) reads as
 * "just now". Missing or invalid times return null, so the caller shows nothing.
 */
export function formatUpdatedAgo(
  timestampMs: number | null | undefined,
  nowMs: number,
): string | null {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }
  const age = nowMs - timestampMs;
  if (age < MINUTE_MS) return 'Updated just now';
  if (age < HOUR_MS) return `Updated ${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `Updated ${Math.floor(age / HOUR_MS)} h ago`;
  if (age < 2 * DAY_MS) return 'Updated yesterday';
  const date = new Date(timestampMs);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return `Updated ${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}
