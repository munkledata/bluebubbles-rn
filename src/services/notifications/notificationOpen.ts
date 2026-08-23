import { logger } from '@core/secure';
import { stashPendingNotification } from './pendingNav';
import { resolveNotificationData } from './notificationRouting';

/**
 * Turn a tapped notification's `data` into a chat deep-link, and navigate there.
 *
 * Message notifications carry `{ chatGuid, messageGuid?, messageDate? }`; reminders add
 * `reminder: '1'` (see notifeeService). A MESSAGE tap opens the chat PLAIN (`/chat/[guid]`)
 * — live at the newest message, bottom-pinned. Only a REMINDER tap deep-links with
 * `?focus=…&focusDate=…` (the anchored mode search hits use): a reminder points at an OLD
 * message worth jumping to, whereas a message notification is about the newest message —
 * and the anchored mode deliberately freezes the bottom-follow behavior (no keyboard
 * follow, no re-pin on send, the jump-to-newest button always shown), which is wrong for
 * normal conversation. On Android a notification's `pressAction: { launchActivity:
 * 'default' }` only FOREGROUNDS the app; it does NOT deep-link, so we do the routing
 * ourselves — from the foreground PRESS event (app alive) and from
 * `getInitialNotification()` (app cold-started by the tap).
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
  /** A "remind me later" notification — the only kind that anchors on its (old) message. */
  reminder?: boolean;
}

/**
 * Extract the open-target from a notification's `data` bag, or null when there's no chat
 * to open (a FaceTime ring, a content-less server notice, the locked-mode placeholder).
 * Tolerant of the loosely-typed native `data` (values may arrive as strings over the bridge).
 */
export function notificationOpenTarget(
  data:
    | {
        [key: string]: unknown;
        chatGuid?: unknown;
        messageGuid?: unknown;
        messageDate?: unknown;
        reminder?: unknown;
      }
    | undefined,
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
    ...(data?.reminder === '1' ? { reminder: true } : {}),
  };
}

/**
 * Build the `/chat/…` deep-link path for a target. A message tap opens the chat PLAIN (live
 * at the newest, bottom-pinned). Only a reminder anchors on its old message with the
 * search-hit format `?focus=<messageGuid>&focusDate=<ms>` (both encoded).
 */
export function chatDeepLink(target: NotificationOpenTarget): string {
  const base = `/chat/${encodeURIComponent(target.chatGuid)}`;
  if (!target.reminder || !target.messageGuid) return base;
  const date = target.messageDate != null ? `&focusDate=${target.messageDate}` : '';
  return `${base}?focus=${encodeURIComponent(target.messageGuid)}${date}`;
}

/**
 * Navigate to the chat a tapped notification is about, if any. `navigate` is the caller's
 * `router.push` — injected so this is testable without expo-router. Returns `true` when the
 * payload was handled (including an intentional no-op for a non-chat notification), or `false`
 * when route resolution/navigation failed and a one-shot caller should preserve the payload.
 */
export async function openFromNotification(
  data: Record<string, unknown> | undefined,
  navigate: (path: string) => void,
): Promise<boolean> {
  try {
    const target = notificationOpenTarget((await resolveNotificationData(data)) ?? undefined);
    if (target) navigate(chatDeepLink(target));
    return true;
  } catch (error) {
    // New native payloads need the encrypted DB to resolve local keys. A foreground caller invokes
    // this fire-and-forget, so contain a failed DB open here rather than creating an unhandled
    // rejection. Returning false lets the one-shot tap drain preserve its payload for a later retry.
    logger.warn('[notif] notification route could not be opened', error);
    return false;
  }
}

/** Minimal structural shape of a notify-kit InitialNotification / EventDetail read here. */
export interface TappedNotification {
  notification?: { data?: Record<string, unknown> };
  /**
   * The press action the user interacted with. Present on a genuine press event and ABSENT on
   * Android's launch-intent echo — the discriminator `drainNotificationTap` relies on.
   */
  pressAction?: { id?: string };
}

/**
 * Is this a REAL press event, or Android replaying the intent that launched the Activity?
 *
 * `getInitialNotification()` is not read-once on Android. It pops the sticky press event, and when
 * there is none it falls back to `activity.getIntent()` — which still carries the `notification`
 * extra that the tap put there, for the Activity's ENTIRE lifetime (RN never calls `setIntent`).
 * The sticky event's bundle carries the `pressAction` alongside the notification; the launch-intent
 * fallback copies only `notification`. So a missing pressAction means "you have already seen this
 * one", and every notification this app posts sets a `pressAction` on its body tap.
 */
function isRealPress(initial: TappedNotification | null): boolean {
  return !!initial?.pressAction;
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
 * The pending stash is destructively read (takePending empties the slot), and the launch event is
 * accepted only when it is a genuine press (see `isRealPress`) — Android keeps re-serving the
 * launching notification from the Activity's intent, which would otherwise TRAP the user:
 * cold-start into chat A, press Back, and the next drain pushes straight back into A. Then a SINGLE
 * `openFromNotification` runs — the two channels describe the same press, so navigating once
 * (preferring the initial's data) avoids pushing the chat twice onto the stack. A failed route lookup
 * restores that one chosen payload to the pending slot; a successful open consumes it permanently.
 * Navigation (or restoration) happens BEFORE best-effort press cleanup, so a cleanup failure cannot
 * cost the one-shot tap. Every dependency is injected, so this is unit-testable without notifee or
 * expo-router.
 */
export async function drainNotificationTap<T extends TappedNotification>(
  getInitial: () => Promise<T | null>,
  takePending: () => Record<string, unknown> | null,
  runPressSideEffects: (detail: T) => void | Promise<void>,
  navigate: (path: string) => void,
  restorePending: (data: Record<string, unknown>) => void = stashPendingNotification,
): Promise<void> {
  const raw = await getInitial();
  const initial = isRealPress(raw) ? raw : null;
  const pending = takePending();
  const tapData = initial?.notification?.data ?? pending ?? undefined;
  const handled = await openFromNotification(tapData, navigate);
  // Both native launch state and the pending slot are destructive reads. Preserve ONE copy when
  // the encrypted route lookup failed so the next foreground drain can retry instead of silently
  // losing the tap. When both sources described the same press, `tapData` already chose one.
  if (!handled && tapData) restorePending(tapData);
  // A cleanup failure is still reported to the layout-level task boundary, but only after the
  // one-shot route either opened successfully or was preserved for a later retry.
  if (initial) await runPressSideEffects(initial);
}
