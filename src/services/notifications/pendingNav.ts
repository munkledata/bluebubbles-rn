import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

export interface NotificationPressOccurrence {
  notification?: { data?: Record<string, unknown> };
  pressAction?: { id?: string };
  /** Native process UUID plus increasing receipt sequence, shared by both delivery channels. */
  pressOccurrenceId?: unknown;
}

export interface NotificationTapReservation {
  readonly data: Record<string, unknown>;
  readonly occurrenceId: string;
  readonly accountLease: RealtimeDeliveryLease;
}

interface ActiveTap extends NotificationTapReservation {
  navigating: boolean;
}

// One native process has one epoch. Retain only its high-water sequence, not an evictable list of
// payloads: an arbitrarily delayed old copy must not become eligible again after many newer taps.
let nativeEpoch: string | null = null;
let highWaterSequence = 0;
let active: ActiveTap | null = null;
let pending: NotificationTapReservation | null = null;

function parseOccurrence(value: unknown): { id: string; epoch: string; sequence: number } | null {
  if (typeof value !== 'string') return null;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,15})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) return null;
  return { id: value, epoch: match[1], sequence };
}

/** Reserve synchronously, before any route lookup. Preparing a tap does not claim navigation. */
export function reserveNotificationTap(
  detail: NotificationPressOccurrence,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): NotificationTapReservation | null {
  if (!accountLease.isCurrent() || !detail.pressAction) return null;
  const occurrence = parseOccurrence(detail.pressOccurrenceId);
  const data = detail.notification?.data;
  if (!occurrence || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (nativeEpoch !== null && nativeEpoch !== occurrence.epoch) return null;
  if (occurrence.sequence < highWaterSequence) return null;
  if (occurrence.sequence === highWaterSequence) {
    return active?.occurrenceId === occurrence.id && isCurrentNotificationTap(active)
      ? active
      : null;
  }

  nativeEpoch = occurrence.epoch;
  highWaterSequence = occurrence.sequence;
  // A newer physical press supersedes an older pending or in-flight route, even for the same chat.
  pending = null;
  active = { data, occurrenceId: occurrence.id, accountLease, navigating: false };
  return active;
}

export function isCurrentNotificationTap(tap: NotificationTapReservation): boolean {
  return active === tap && tap.accountLease.isCurrent();
}

/** One caller owns navigation until its lookup settles; duplicate channels cannot join it. */
export function claimNotificationTap(tap: NotificationTapReservation): boolean {
  if (!isCurrentNotificationTap(tap) || !active || active.navigating) return false;
  active.navigating = true;
  return true;
}

export function settleNotificationTap(tap: NotificationTapReservation, handled: boolean): void {
  if (!isCurrentNotificationTap(tap) || !active) return;
  if (handled) {
    active = null;
    pending = null;
  } else {
    active.navigating = false;
  }
}

/** Publish only an already-reserved, account-validated tap; a late consumed copy is a no-op. */
export function stashPendingNotification(tap: NotificationTapReservation): void {
  if (isCurrentNotificationTap(tap)) pending = tap;
}

/** Destructive read of the newest validated tap, including a retry after a failed route lookup. */
export function takePendingNotification(): NotificationTapReservation | null {
  const tap = pending;
  pending = null;
  return tap && isCurrentNotificationTap(tap) ? tap : null;
}

/** Drop account data/claims, but keep the known retired-token floor from being adopted by B. */
export function resetPendingNotification(): void {
  active = null;
  pending = null;
}
