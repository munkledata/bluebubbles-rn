/**
 * Pure app-lock timeout check. Returns true if the app has been backgrounded
 * for at least `timeoutMs` and should re-lock on resume. Null `lastBackgrounded`
 * (never backgrounded this session) never expires.
 */
export function isLockExpired(
  lastBackgrounded: number | null,
  now: number,
  timeoutMs: number,
): boolean {
  if (lastBackgrounded == null) return false;
  return now - lastBackgrounded >= timeoutMs;
}
