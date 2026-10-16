import { logger } from '@core/secure';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  claimNotificationTap,
  isCurrentNotificationTap,
  reserveNotificationTap,
  settleNotificationTap,
  stashPendingNotification,
  takePostponedNotificationPress,
  type NotificationPressOccurrence,
  type NotificationTapReservation,
} from './pendingNav';
import { resolveNotificationData } from './notificationRouting';

/**
 * Turn a tapped notification's `data` into a safe app deep-link, and navigate there.
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
 * Navigation is injected so this stays a pure, unit-testable function with no expo-router
 * dependency. Chat and inbox navigation are deliberately separate: chat navigation has special
 * push/replace rules that are not valid for returning to the inbox.
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

/** Explicit destinations supported by notification body taps. */
export interface NotificationNavigation {
  openChat: (path: string) => void;
  openInbox: () => void;
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
 * Navigate to the chat a tapped notification is about, or to the inbox for the owned message-group
 * summary. Navigation is injected so this is testable without expo-router. Returns `true` when the
 * payload was handled (including an intentional no-op for a non-chat notification), or `false`
 * when route resolution/navigation failed and a one-shot caller should preserve the payload.
 */
export async function openFromNotification(
  data: Record<string, unknown> | undefined,
  navigation: NotificationNavigation,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  isCurrentTap: () => boolean = () => true,
): Promise<boolean> {
  if (!accountLease.isCurrent() || !isCurrentTap()) return true;
  try {
    const resolved = await resolveNotificationData(data);
    if (!accountLease.isCurrent() || !isCurrentTap()) return true;
    if (resolved?.inbox === '1') {
      navigation.openInbox();
      return true;
    }
    const target = notificationOpenTarget(resolved ?? undefined);
    if (target) navigation.openChat(chatDeepLink(target));
    return true;
  } catch (error) {
    if (!accountLease.isCurrent() || !isCurrentTap()) return true;
    // New native payloads need the encrypted DB to resolve local keys. A foreground caller invokes
    // this fire-and-forget, so contain a failed DB open here rather than creating an unhandled
    // rejection. Returning false lets the one-shot tap drain preserve its payload for a later retry.
    logger.warn('[notif] notification route could not be opened', error);
    return false;
  }
}

/** Minimal structural shape of a notify-kit InitialNotification / EventDetail read here. */
export type TappedNotification = NotificationPressOccurrence;

async function openReservedNotificationTap(
  tap: NotificationTapReservation,
  navigation: NotificationNavigation,
): Promise<{ claimed: boolean; handled: boolean }> {
  if (!claimNotificationTap(tap)) return { claimed: false, handled: true };
  let handled = false;
  try {
    handled = await openFromNotification(tap.data, navigation, tap.accountLease, () =>
      isCurrentNotificationTap(tap),
    );
    return { claimed: true, handled };
  } finally {
    settleNotificationTap(tap, handled);
  }
}

/** Foreground presses share the exact same occurrence claim as initial/background delivery. */
export async function openNotificationPress(
  detail: TappedNotification,
  navigation: NotificationNavigation,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const tap = reserveNotificationTap(detail, accountLease);
  if (!tap) return;
  const result = await openReservedNotificationTap(tap, navigation);
  if (!result.handled && accountLease.isCurrent()) stashPendingNotification(tap);
}

/**
 * Is this a REAL press event, or Android replaying the intent that launched the Activity?
 *
 * `getInitialNotification()` is not read-once on Android. It pops the sticky press event, and when
 * there is none it falls back to `activity.getIntent()` — which still carries the `notification`
 * extra that the tap put there, for the Activity's ENTIRE lifetime (RN never calls `setIntent`).
 * The sticky bundle carries `pressAction`; the fallback copies only `notification`. This rejects
 * the fallback, but is NOT sufficient for one-shot delivery: a late genuine channel copy still
 * has pressAction. The shared native occurrence reservation below rejects that duplicate.
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
 * The native receiver gives both copies one process-epoch/sequence identity. A copy delivered
 * after a successful open cannot be reserved again, even if it still carries a pressAction. A
 * newer physical press supersedes old held work. Preparing the background copy does not claim
 * navigation; the first active caller does. A failed lookup releases that claim and preserves the
 * same leased reservation for retry. Tokenless Activity-intent echoes are never navigation.
 * Navigation (or restoration) happens BEFORE best-effort press cleanup, so a cleanup failure cannot
 * cost the one-shot tap. Every dependency is injected, so this is unit-testable without notifee or
 * expo-router.
 */
export async function drainNotificationTap<T extends TappedNotification>(
  getInitial: () => Promise<T | null>,
  takePending: () => NotificationTapReservation | null,
  runPressSideEffects: (detail: TappedNotification) => void | Promise<void>,
  navigation: NotificationNavigation,
  restorePending: (tap: NotificationTapReservation) => void = stashPendingNotification,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  if (!accountLease.isCurrent()) return;
  const raw = await getInitial();
  if (!accountLease.isCurrent()) return;
  const initial = isRealPress(raw) ? raw : null;
  const initialTap = initial ? reserveNotificationTap(initial, accountLease) : null;
  const pending = takePending();
  const tap = initialTap ?? pending;
  if (!tap) return;
  const result = await openReservedNotificationTap(tap, navigation);
  if (!accountLease.isCurrent()) return;
  if (!result.claimed) return;
  if (!result.handled) restorePending(tap);
  // A cleanup failure is still reported to the layout-level task boundary, but only after the
  // one-shot route either opened successfully or was preserved for a later retry.
  // Side effects the background handler postponed under App Lock (review M102) are taken here,
  // once: the app is unlocked now, and a retried open must not repeat them.
  const postponedPress = takePostponedNotificationPress(tap);
  if (initial && initialTap === tap && accountLease.isCurrent()) {
    await runPressSideEffects(initial);
  } else if (postponedPress && accountLease.isCurrent()) {
    await runPressSideEffects({
      notification: { id: postponedPress.notificationId, data: tap.data },
      pressAction: { id: postponedPress.actionId },
      pressOccurrenceId: tap.occurrenceId,
    });
  }
}
