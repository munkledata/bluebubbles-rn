/** Max automatic retries before a queued send retires to the 'error' bubble. */
export const OUTGOING_MAX_ATTEMPTS = 5;
// A freshly-inserted row is assumed in-flight (the UI send owns it) for this long, so
// the retry processor won't double-send it; past this, an un-deleted row is stranded.
export const OUTGOING_GRACE_MS = 60_000;
/** Internal lease set while one retry attempt is in flight. Not part of the facade API. */
export const OUTGOING_LEASE_MS = 120_000;

/** Exponential backoff for retry N (1-based): 30s, 60s, 120s, 240s, 480s — capped at 1h. */
export function outgoingBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}
