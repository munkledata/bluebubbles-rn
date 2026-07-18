import notifee, {
  AlarmType,
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  TriggerType,
  type TimestampTrigger,
} from 'react-native-notify-kit';
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
export const ACTION_LOVE = 'love';
export const ACTION_ANSWER_FACETIME = 'answer-facetime';
export const ACTION_DECLINE_FACETIME = 'decline-facetime';

// Hide-preview (redacted) toggle — when on, the body shows a generic string.
let hidePreview = false;
export function setHideNotificationPreview(value: boolean): void {
  hidePreview = value;
}

// Fallback avatar for a sender with no contact photo: the Gator mark, so the notification shows
// our icon instead of Android's generic gray silhouette. Resolved once at module load — headless-
// safe (the require + RN asset registry are available even in the FCM wake context). Guarded:
// resolveAssetSource can return undefined, and notify-kit throws on `icon: undefined`.
let gatorAvatarUri: string | undefined;
try {
  // Lazy require (literal strings, so Metro still bundles both) — the React-free node/jest import
  // graph never evaluates react-native, and any failure here just leaves the fallback undefined.
  const { Image } = require('react-native') as typeof import('react-native');
  gatorAvatarUri = Image.resolveAssetSource(
    require('../../../assets/notification-avatar.png') as number,
  )?.uri;
} catch {
  gatorAvatarUri = undefined;
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

/** Stable per-chat notification channel id (Android channel ids allow only a safe charset). */
export function chatChannelId(chatGuid: string): string {
  return `${CHANNEL_NEW_MESSAGE}.chat.${chatGuid.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Create a per-conversation notification channel (if absent) and open its Android system settings,
 * so the user can set a custom sound / importance / vibration for THIS chat. Once created, that
 * chat's message notifications route to it (see `postNotification`). Parity with the old app's
 * per-chat "Notification Settings" tile. Android-only; a no-op elsewhere.
 */
export async function openChatNotificationSettings(chatGuid: string, title: string): Promise<void> {
  const id = chatChannelId(chatGuid);
  await notifee.createChannel({
    id,
    name: title || 'Conversation',
    importance: AndroidImportance.HIGH,
  });
  await notifee.openNotificationSettings(id);
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
  if (intent.kind === 'rcs-bridge-down') {
    await ensureChannel();
    // A server STATUS notice (RCS bridge dropped / auth expired). Carries no message content, so
    // no redaction is applied — the server-supplied title/body are shown verbatim. A fixed id
    // updates in place instead of stacking on repeated pushes.
    await notifee.displayNotification({
      id: 'bb-rcs-bridge-down',
      title: intent.title,
      body: intent.body,
      android: {
        channelId: CHANNEL_NEW_MESSAGE,
        smallIcon: 'ic_launcher',
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      },
    });
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
  // Route to this chat's OWN channel if the user has customized it (created via
  // openChatNotificationSettings); else the shared "New Messages" channel. getChannel returns null
  // for an uncreated channel, so this is a cheap per-post check with no persisted bookkeeping.
  const perChatId = chatChannelId(intent.chatGuid);
  const channelId = (await notifee.getChannel(perChatId).catch(() => null))
    ? perChatId
    : CHANNEL_NEW_MESSAGE;
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
    // messageDate lets a notification tap deep-link with ?focusDate so the chat loads a
    // window CENTERED on the message (older messages resolve reliably, not just recent ones).
    data: {
      chatGuid: intent.chatGuid,
      messageGuid: intent.messageGuid,
      messageDate: String(intent.timestamp),
    },
    android: {
      channelId,
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
              // Contact photo when we have one; otherwise the Gator mark instead of Android's
              // gray silhouette. Never in redacted mode (matches dropping the real avatar), and
              // only when the value is a string — notify-kit throws on `icon: undefined`.
              ...(!hidePreview && (intent.avatarUri ?? gatorAvatarUri)
                ? { icon: (intent.avatarUri ?? gatorAvatarUri) as string }
                : {}),
            },
          },
        ],
      },
      // Android caps inline actions at ~3; keep Reply + Mark-as-read + one tapback.
      actions: [
        {
          title: 'Reply',
          pressAction: { id: ACTION_REPLY },
          input: { allowFreeFormInput: true, placeholder: 'Message' },
        },
        { title: 'Mark as read', pressAction: { id: ACTION_MARK_READ } },
        { title: '♥ Love', pressAction: { id: ACTION_LOVE } },
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
    title: 'Gator',
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
  /** The reminded message's timestamp (ms) — carried so a tap deep-links with ?focusDate and
   *  scrolls to the message. Omitted when the message's date is unknown. */
  messageDate?: number;
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
        data: {
          chatGuid: args.chatGuid,
          messageGuid: args.messageGuid,
          reminder: '1',
          // Only include when known — notificationOpenTarget ignores a non-numeric/missing value.
          ...(args.messageDate != null ? { messageDate: String(args.messageDate) } : {}),
        },
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
