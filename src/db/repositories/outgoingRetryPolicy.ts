/** Max automatic retries before a queued send retires to the 'error' bubble. */
export const OUTGOING_MAX_ATTEMPTS = 5;
// A freshly-inserted row is assumed in-flight (the UI send owns it) for this long, so
// the retry processor won't double-send it; past this, an un-deleted row is stranded.
export const OUTGOING_GRACE_MS = 60_000;
/** Internal lease set while one retry attempt is in flight. Not part of the facade API. */
export const OUTGOING_LEASE_MS = 120_000;

export type IMessagePlainTextQueueState = 'legacy' | 'unsafe' | 'retry-safe';

function parsePayloadRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read the durable route marker without inferring a helper send from mutable message contents. */
export function imessagePlainTextQueueState(
  kind: string,
  payload: string,
): IMessagePlainTextQueueState {
  const parsed = parsePayloadRecord(payload);
  if (!parsed) return 'legacy';
  const hasRouteMarker = Object.prototype.hasOwnProperty.call(parsed, 'imessagePlainTextV1');
  const hasRetryProof = Object.prototype.hasOwnProperty.call(
    parsed,
    'imessagePlainTextRetrySafeV1',
  );
  if (!hasRouteMarker && !hasRetryProof) return 'legacy';
  if (
    kind !== 'text' ||
    parsed.imessagePlainTextV1 !== true ||
    typeof parsed.message !== 'string' ||
    Object.keys(parsed).some(
      (key) =>
        key !== 'message' &&
        key !== 'imessagePlainTextV1' &&
        key !== 'imessagePlainTextRetrySafeV1',
    )
  ) {
    return 'unsafe';
  }
  return parsed.imessagePlainTextRetrySafeV1 === true ? 'retry-safe' : 'unsafe';
}

/** Set or consume the one-use retry proof only on an explicitly marked narrow-text payload. */
export function withIMessagePlainTextRetrySafety(
  payload: string,
  retrySafe: boolean,
): string | null {
  const parsed = parsePayloadRecord(payload);
  if (parsed?.imessagePlainTextV1 !== true) return null;
  if (retrySafe) parsed.imessagePlainTextRetrySafeV1 = true;
  else delete parsed.imessagePlainTextRetrySafeV1;
  return JSON.stringify(parsed);
}

/** Exponential backoff for retry N (1-based): 30s, 60s, 120s, 240s, 480s — capped at 1h. */
export function outgoingBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}
