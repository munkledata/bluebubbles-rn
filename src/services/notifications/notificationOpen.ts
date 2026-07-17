/**
 * Turn a tapped notification's `data` into a chat deep-link, and navigate there.
 *
 * Message/reminder notifications carry `{ chatGuid, messageGuid?, messageDate? }`
 * (see notifeeService). Tapping one must open the chat AND scroll to + highlight that
 * message — the very same `/chat/[guid]?focus=…&focusDate=…` route the in-app search
 * hits already use (see SearchResultsView.openMessage). On Android a notification's
 * `pressAction: { launchActivity: 'default' }` only FOREGROUNDS the app; it does NOT
 * deep-link, so we do the routing ourselves — from the foreground PRESS event (app
 * alive) and from `getInitialNotification()` (app cold-started by the tap).
 *
 * `navigate` is injected so this stays a pure, unit-testable function with no
 * expo-router dependency.
 */

/** A chat to open from a notification tap, with an optional message to focus on. */
export interface NotificationOpenTarget {
  chatGuid: string;
  messageGuid?: string;
  /** Message timestamp (ms) — lets the chat load a window CENTERED on an old message. */
  messageDate?: number;
}

/**
 * Extract the open-target from a notification's `data` bag, or null when there's no chat
 * to open (a FaceTime ring, a content-less server notice, the locked-mode placeholder).
 * Tolerant of the loosely-typed native `data` (values may arrive as strings over the bridge).
 */
export function notificationOpenTarget(
  data: Record<string, unknown> | undefined,
): NotificationOpenTarget | null {
  const chatGuid = typeof data?.chatGuid === 'string' ? data.chatGuid : undefined;
  if (!chatGuid) return null;
  const messageGuid = typeof data?.messageGuid === 'string' ? data.messageGuid : undefined;
  // messageDate is a stringified ms epoch; accept a number too, ignore anything non-numeric.
  const raw = data?.messageDate;
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  const messageDate = Number.isFinite(parsed) ? parsed : undefined;
  return {
    chatGuid,
    ...(messageGuid ? { messageGuid } : {}),
    ...(messageDate != null ? { messageDate } : {}),
  };
}

/**
 * Build the `/chat/…` deep-link path for a target. Mirrors SearchResultsView's format:
 * `?focus=<messageGuid>&focusDate=<ms>` (both encoded); message focus is optional.
 */
export function chatDeepLink(target: NotificationOpenTarget): string {
  const base = `/chat/${encodeURIComponent(target.chatGuid)}`;
  if (!target.messageGuid) return base;
  const date = target.messageDate != null ? `&focusDate=${target.messageDate}` : '';
  return `${base}?focus=${encodeURIComponent(target.messageGuid)}${date}`;
}

/**
 * Navigate to the chat a tapped notification is about, if any. `navigate` is the caller's
 * `router.push` — injected so this is testable without expo-router. A no-op for a
 * notification that isn't about a chat.
 */
export function openFromNotification(
  data: Record<string, unknown> | undefined,
  navigate: (path: string) => void,
): void {
  const target = notificationOpenTarget(data);
  if (target) navigate(chatDeepLink(target));
}

/** Minimal structural shape of a notify-kit InitialNotification / EventDetail read here. */
export interface TappedNotification {
  notification?: { data?: Record<string, unknown> };
}

/**
 * Drain a pending notification tap at foreground time and open its chat EXACTLY ONCE.
 *
 * A resume-time tap can arrive through two independent channels, so this reads BOTH:
 *  - notify-kit's `getInitialNotification()` — the sticky launch event, posted for a killed-app
 *    cold-start AND for a background-alive press; and
 *  - the `pendingNav` stash set by `onBackgroundEvent` (the deterministic same-JS-context backstop
 *    for a background-alive press, in case the sticky event isn't delivered).
 *
 * Both sources are CLEARED (getInitial is read-once; takePending empties the slot) so a stale tap
 * can't re-fire on a later resume, then a SINGLE `openFromNotification` runs — the two channels
 * describe the same press, so navigating once (preferring the initial's data) avoids pushing the
 * chat twice onto the stack. `runPressSideEffects` runs the DB side-effects (reminder cleanup) for
 * a real launch press. Every dependency is injected, so this is unit-testable without notifee or
 * expo-router.
 */
export async function drainNotificationTap<T extends TappedNotification>(
  getInitial: () => Promise<T | null>,
  takePending: () => Record<string, unknown> | null,
  runPressSideEffects: (detail: T) => void | Promise<void>,
  navigate: (path: string) => void,
): Promise<void> {
  const initial = await getInitial();
  const pending = takePending();
  if (initial) await runPressSideEffects(initial);
  openFromNotification(initial?.notification?.data ?? pending ?? undefined, navigate);
}
