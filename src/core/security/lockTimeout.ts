/**
 * Pure app-lock timeout check. Returns true if the app has been backgrounded for at least
 * `timeoutMs` and should re-lock on resume. Null `lastBackgrounded` (never backgrounded this
 * session) never expires.
 *
 * Both stamps are wall-clock (`Date.now()`): Android's monotonic clock stops while the device
 * sleeps, so it would under-count an hour in a pocket. Setting the clock FORWARD only locks sooner;
 * a `now` before `lastBackgrounded` means it was set BACK, so the grace period cannot be measured
 * and the check fails closed and locks.
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
