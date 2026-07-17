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
