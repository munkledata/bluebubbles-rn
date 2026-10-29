import type { EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import { nativeNotificationAdapter as notifee } from './nativeNotificationAdapter';
import { cancelNotificationById } from './notifeeService';
import { chatNotificationId } from './notificationRouting';

/** The exact opaque id of one chat's message notification, or null for anything else. */
function messageNotificationIdOrNull(id: string | undefined): string | null {
  const match = /^gator-message-([1-9]\d*)$/.exec(id ?? '');
  if (!match) return null;
  const chatId = Number(match[1]);
  return Number.isSafeInteger(chatId) && chatNotificationId(chatId) === id ? id : null;
}

/**
 * Remove every chat's message notification from the tray after "Mark All Read" committed: those
 * messages are read now, so their notices are stale. Only per-chat message notices are touched —
 * reminders, send-failure notices, FaceTime calls and the generic locked notice keep their own ids
 * and stay. Each cancel goes through the shared notification queue, which re-checks the account
 * lease and repairs the group summary. Best-effort: a failure leaves the tray as it was, and the
 * notices still clear when their chat is opened.
 */
export async function clearAllMessageNotifications(context: EventDeliveryContext): Promise<void> {
  if (!context.isCurrent()) return;
  try {
    const displayed = await notifee.getDisplayedNotifications();
    if (!context.isCurrent()) return;
    const ids = new Set<string>();
    for (const item of displayed) {
      const id = messageNotificationIdOrNull(item.notification?.id ?? item.id);
      if (id) ids.add(id);
    }
    for (const id of ids) {
      if (!context.isCurrent()) return;
      await cancelNotificationById(id, context);
    }
  } catch (error) {
    if (!context.isCurrent()) return;
    logger.warn('[notif] clearing read message notifications failed', error);
  }
}
