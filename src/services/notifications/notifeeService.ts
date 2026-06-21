import notifee, {
  AlarmType,
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  TriggerType,
  type TimestampTrigger,
} from '@notifee/react-native';
import type { NotificationIntent } from '@core/realtime';
import { logger } from '@core/secure';
import { redactTitle } from '@utils';

export const CHANNEL_NEW_MESSAGE = 'com.bluegreengatorapps.messages.new_messages';
export const CHANNEL_REMINDERS = 'com.bluegreengatorapps.messages.reminders';
export const CHANNEL_FACETIME = 'com.bluegreengatorapps.messages.facetime';
export const PRESS_OPEN = 'open-chat';
export const PRESS_REMINDER = 'open-reminder';
export const ACTION_REPLY = 'reply';
export const ACTION_MARK_READ = 'mark-read';
export const ACTION_ANSWER_FACETIME = 'answer-facetime';
export const ACTION_DECLINE_FACETIME = 'decline-facetime';

// Hide-preview (redacted) toggle — when on, the body shows a generic string.
let hidePreview = false;
export function setHideNotificationPreview(value: boolean): void {
  hidePreview = value;
}

let channelReady: Promise<string> | null = null;
function ensureChannel(): Promise<string> {
  channelReady ??= notifee.createChannel({
    id: CHANNEL_NEW_MESSAGE,
    name: 'New Messages',
    importance: AndroidImportance.HIGH,
  });
  return channelReady;
}

/** Request POST_NOTIFICATIONS (Android 13+). Returns true if allowed. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
}

/**
 * Show (or, for a cancel intent, clear) a chat notification. One notification
 * per chat (id = chatGuid) so a newer message updates it in place. Uses the
 * Android MESSAGING style so it threads with sender + avatar; carries inline
 * Reply + Mark-as-read actions handled by `handleNotificationAction`.
 */
export async function postNotification(intent: NotificationIntent): Promise<void> {
  if (intent.kind === 'cancel') {
    await cancelForChat(intent.chatGuid);
    return;
  }
  if (intent.kind === 'facetime-cancel') {
    await notifee.cancelNotification(`ft-${intent.uuid}`);
    return;
  }
  if (intent.kind === 'facetime-call') {
    await postFaceTimeNotification(intent);
    return;
  }
  if (intent.kind === 'alias-removed') {
    await ensureChannel();
    // The alias is the user's OWN address; still honor redacted mode for the body.
    const body = hidePreview
      ? 'An iMessage alias was deregistered.'
      : intent.aliases.length === 1
        ? `${intent.aliases[0]} has been deregistered.`
        : `Aliases deregistered: ${intent.aliases.join(', ')}`;
    await notifee.displayNotification({
      id: 'bb-aliases-removed',
      title: 'iMessage',
      body,
      android: {
        channelId: CHANNEL_NEW_MESSAGE,
        smallIcon: 'ic_launcher',
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      },
    });
    return;
  }
  await ensureChannel();
  // Redacted mode hides BOTH content and who: mask the body, the chat title, and the
  // sender name, and drop the avatar — otherwise the notification still reveals the
  // contact. `redactTitle` returns the generic placeholder when the flag is on.
  const body = hidePreview ? 'New message' : intent.body;
  const title = redactTitle(intent.chatTitle, hidePreview);
  const senderName = redactTitle(intent.senderName, hidePreview);
  await notifee.displayNotification({
    id: intent.chatGuid,
    title,
    body,
    data: { chatGuid: intent.chatGuid, messageGuid: intent.messageGuid },
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_launcher',
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You', id: 'self' },
        group: intent.isGroup,
        messages: [
          {
            text: body,
            timestamp: intent.timestamp,
            person: {
              name: senderName,
              id: intent.senderHandle,
              // `icon` must be a string when present — omit entirely when no avatar, and
              // never attach the avatar in redacted mode (it would reveal the contact).
              ...(intent.avatarUri && !hidePreview ? { icon: intent.avatarUri } : {}),
            },
          },
        ],
      },
      actions: [
        {
          title: 'Reply',
          pressAction: { id: ACTION_REPLY },
          input: { allowFreeFormInput: true, placeholder: 'Message' },
        },
        { title: 'Mark as read', pressAction: { id: ACTION_MARK_READ } },
      ],
    },
  });
}

export async function cancelForChat(chatGuid: string): Promise<void> {
  await notifee.cancelNotification(chatGuid);
}

/**
 * A single content-less "you have messages" notification, used when a background push
 * arrives while the app is LOCKED — we do NOT open/decrypt the DB or reveal any sender or
 * content. A fixed id keeps repeated locked pushes from stacking. Tapping opens the app to
 * the lock screen, after which sync delivers the real per-chat notifications.
 */
export async function postLockedNotification(): Promise<void> {
  await ensureChannel();
  await notifee.displayNotification({
    id: 'bb-locked-messages',
    title: 'BlueBubbles',
    body: 'You have new messages',
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_launcher',
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  });
}

let faceTimeChannelReady: Promise<string> | null = null;
function ensureFaceTimeChannel(): Promise<string> {
  faceTimeChannelReady ??= notifee
    .createChannel({ id: CHANNEL_FACETIME, name: 'FaceTime', importance: AndroidImportance.HIGH })
    .catch((e) => {
      faceTimeChannelReady = null;
      throw e;
    });
  return faceTimeChannelReady;
}

/**
 * Post an "Incoming FaceTime" heads-up/full-screen notification with Answer +
 * Decline actions (id = ft-<uuid> so the call's 'ended' event can cancel it).
 * Ongoing + high-importance so it rings until answered/declined.
 */
async function postFaceTimeNotification(intent: {
  uuid: string;
  callerName: string;
  isAudio: boolean;
  avatarUri?: string;
}): Promise<void> {
  await ensureFaceTimeChannel();
  await notifee.displayNotification({
    id: `ft-${intent.uuid}`,
    title: intent.isAudio ? 'Incoming FaceTime Audio' : 'Incoming FaceTime',
    // Respect the hide-preview privacy toggle (don't leak the caller on the lock screen).
    body: hidePreview ? 'Incoming call' : intent.callerName,
    data: { faceTimeUuid: intent.uuid },
    android: {
      channelId: CHANNEL_FACETIME,
      smallIcon: 'ic_launcher',
      importance: AndroidImportance.HIGH,
      category: AndroidCategory.CALL,
      ongoing: true,
      autoCancel: false,
      fullScreenAction: { id: 'default', launchActivity: 'default' },
      pressAction: { id: 'default', launchActivity: 'default' },
      actions: [
        { title: 'Decline', pressAction: { id: ACTION_DECLINE_FACETIME } },
        { title: 'Answer', pressAction: { id: ACTION_ANSWER_FACETIME, launchActivity: 'default' } },
      ],
    },
  });
}

let reminderChannelReady: Promise<string> | null = null;
function ensureReminderChannel(): Promise<string> {
  // Don't memoize a rejected promise — clear the cache on failure so a later
  // call can retry instead of being permanently broken.
  reminderChannelReady ??= notifee
    .createChannel({ id: CHANNEL_REMINDERS, name: 'Reminders', importance: AndroidImportance.HIGH })
    .catch((e) => {
      reminderChannelReady = null;
      throw e;
    });
  return reminderChannelReady;
}

/**
 * Schedule a one-shot reminder notification. Uses an INEXACT timestamp trigger
 * (no `alarmManager` options) so it needs no SCHEDULE_EXACT_ALARM permission —
 * best-effort timing is fine for reminders. Honors the hide-preview toggle.
 */
export async function scheduleReminderNotification(args: {
  notificationId: string;
  chatGuid: string;
  messageGuid: string;
  title: string;
  body: string;
  scheduledFor: number;
}): Promise<void> {
  await ensureReminderChannel();
  // SET_AND_ALLOW_WHILE_IDLE = inexact alarm that still fires in Doze — needs NO
  // SCHEDULE_EXACT_ALARM permission (exact alarms throw a SecurityException on
  // Android 12+ without it). Best-effort timing is fine for reminders.
  const trigger: TimestampTrigger = {
    type: TriggerType.TIMESTAMP,
    timestamp: args.scheduledFor,
    alarmManager: { type: AlarmType.SET_AND_ALLOW_WHILE_IDLE },
  };
  try {
    await notifee.createTriggerNotification(
      {
        id: args.notificationId,
        title: args.title,
        body: hidePreview ? 'Reminder' : args.body,
        data: { chatGuid: args.chatGuid, messageGuid: args.messageGuid, reminder: '1' },
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_launcher',
          pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
        },
      },
      trigger,
    );
  } catch (e) {
    logger.warn('[reminder] createTriggerNotification failed', e);
    throw e;
  }
}

export async function cancelReminderNotification(notificationId: string): Promise<void> {
  await notifee.cancelTriggerNotification(notificationId);
}

/** Fire-and-forget cancel — call when a chat is opened/read in the UI. */
export function clearChatNotification(chatGuid: string): void {
  void notifee.cancelNotification(chatGuid);
}
