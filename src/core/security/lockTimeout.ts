/**
 * Pure app-lock timeout check. Returns true if the app has been backgrounded for at least
 * `timeoutMs` and should re-lock on resume. Null `lastBackgrounded` (never backgrounded this
 * session) never expires.
 *
 * Both stamps must come from the same clock (see `monotonicNow`). A `now` before
 * `lastBackgrounded` means that clock went backwards, or the stamps came from different clocks;
 * either way the grace period cannot be measured, so the check fails closed and locks.
 */
export function isLockExpired(
  lastBackgrounded: number | null,
  now: number,
  timeoutMs: number,
): boolean {
  if (lastBackgrounded == null) return false;
  if (now < lastBackgrounded) return true;
  return now - lastBackgrounded >= timeoutMs;
}
