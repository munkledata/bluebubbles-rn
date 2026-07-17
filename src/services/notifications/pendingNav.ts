/**
 * A one-slot stash for a notification tap that must be navigated AFTER the React tree is next
 * active.
 *
 * WHY THIS EXISTS: a tap on a message notification while the app is alive-but-backgrounded is
 * delivered to the headless `onBackgroundEvent` handler — notify-kit routes a PRESS to the
 * foreground emitter (`onForegroundEvent`) ONLY when the Activity is RESUMED; otherwise the press
 * goes to the background handler. That handler has no router, so it cannot deep-link. It stashes
 * the tapped notification's `data` here, and the connected layout drains it on the next AppState
 * 'active' and opens the chat. This is the fix for the "tapping a notification doesn't open the
 * thread" bug: previously the background-alive tap only foregrounded the app on its last screen.
 *
 * Module-level (NOT persisted) on purpose: for a background-ALIVE app the `onBackgroundEvent`
 * callback runs in the SAME JS context as the layout, so the value survives until the resume. A
 * KILLED-app tap runs `onBackgroundEvent` in a throwaway headless context and then cold-starts a
 * fresh JS context where this slot is empty again — that path is covered separately by
 * `getInitialNotification()` in the layout's mount effect, not by this stash. A single slot is
 * enough: only the most-recently-tapped notification matters, and the layout clears it on drain.
 */
let pending: Record<string, unknown> | null = null;

/** Record the tapped notification's `data` bag (a no-op for a missing/non-object value). */
export function stashPendingNotification(data: Record<string, unknown> | undefined): void {
  if (data && typeof data === 'object') pending = data;
}

/** Return the stashed tap and clear the slot, so a stale tap can't re-fire on a later resume. */
export function takePendingNotification(): Record<string, unknown> | null {
  const p = pending;
  pending = null;
  return p;
}
