import {
  AlarmType,
  AndroidCategory,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  TriggerType,
  nativeNotificationAdapter as notifee,
  type DisplayedNotification,
  type Notification,
  type TimestampTrigger,
  type TriggerNotification,
} from './nativeNotificationAdapter';
import type { EventDeliveryContext, NotificationIntent } from '@core/realtime';
import { logger } from '@core/secure';
import type { AppDatabase } from '@db/types';
import { useLockStore } from '@state/lockStore';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '../realtime/deliveryCoordinator';
import { effectivelyLocked } from './lockGate';
import { isActiveChat } from './activeChat';
import {
  MESSAGE_HISTORY_IDS_KEY,
  decodeMessageHistoryIds,
  encodeMessageHistoryIds,
  mergeMessageNotificationHistory,
  removeMessageFromNotificationHistory,
  type MessageNotificationHistoryEntry,
} from './messageHistory';
import {
  NOTIFICATION_DATA_OWNER,
  NOTIFICATION_DATA_SCHEMA,
  chatChannelIdForLocalId,
  chatNotificationId,
  clearNotificationRoutes,
  deleteFaceTimeRoute,
  faceTimeNotificationId,
  findFaceTimeRoute,
  getOrCreateFaceTimeRoute,
  isSafeReminderNotificationId,
  listFutureReminderTriggerRoutes,
  localFailedMessageRoute,
  localRouteForGuids,
  localRouteForMessageGuid,
  migrateReminderNotificationId,
  nativeFaceTimeData,
  nativeRouteData,
  nativeStatusData,
  replacementReminderNotificationId,
  resolveNotificationData,
  sendFailureNotificationId,
} from './notificationRouting';

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

/**
 * Every native notification mutation runs through one queue. Legacy payload maintenance and
 * account teardown enumerate and replace OS state, so allowing a post/cancel to race either
 * read-modify-write sequence could leave old account data behind or resurrect a dismissed notice.
 *
 * Keep maintenance helpers below PRIVATE and call notify-kit directly from inside their queue
 * slot. Calling an exported queued helper there would wait on the slot it already owns.
 */
let notificationOperationTail: Promise<void> = Promise.resolve();
function enqueueNotificationOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = notificationOperationTail.then(operation);
  // A failed native call is returned to its caller, but must not poison every later operation.
  notificationOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const STATUS_LOCKED_ID = 'bb-locked-messages';
const STATUS_RCS_ID = 'bb-rcs-bridge-down';
const STATUS_TEST_ID = 'bb-test-notification';
const STATUS_ALIAS_ID = 'bb-aliases-removed';
const SEND_FAILURE_TITLE = 'Message not sent';
const SEND_FAILURE_BODY = 'Open Gator to review and retry.';

function dataString(data: Notification['data'], key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function notificationId(notification: Notification, displayedId?: string): string | undefined {
  const id = notification.id ?? displayedId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function messageActions(includeLove: boolean): NonNullable<Notification['android']>['actions'] {
  return [
    {
      title: 'Reply',
      pressAction: { id: ACTION_REPLY },
      input: { allowFreeFormInput: true, placeholder: 'Message' },
    },
    { title: 'Mark as read', pressAction: { id: ACTION_MARK_READ } },
    ...(includeLove ? [{ title: '♥ Love', pressAction: { id: ACTION_LOVE } }] : []),
  ];
}

interface DisplayedMessageHistory {
  entries: MessageNotificationHistoryEntry[];
  title: string;
  channelId: string;
  isGroup: boolean;
}

function positiveLocalId(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function messageHistoryData(entries: readonly MessageNotificationHistoryEntry[]): {
  [MESSAGE_HISTORY_IDS_KEY]: string;
} {
  return { [MESSAGE_HISTORY_IDS_KEY]: encodeMessageHistoryIds(entries) };
}

function messagingStyleLines(entries: readonly MessageNotificationHistoryEntry[]) {
  return entries.map((entry) => ({
    text: entry.text,
    timestamp: entry.timestamp,
    person: {
      name: entry.senderName,
      id: 'contact',
      ...(entry.avatarUri ? { icon: entry.avatarUri } : {}),
    },
  }));
}

/** Accept only this build's bounded schema-2 history; malformed/legacy state is never merged. */
function parseDisplayedMessageHistory(
  displayed: DisplayedNotification,
  chatId: number,
): DisplayedMessageHistory | null {
  const source = displayed.notification;
  if (notificationId(source, displayed.id) !== chatNotificationId(chatId)) return null;
  if (
    dataString(source.data, 'gatorOwner') !== NOTIFICATION_DATA_OWNER ||
    dataString(source.data, 'gatorSchema') !== NOTIFICATION_DATA_SCHEMA ||
    dataString(source.data, 'gatorKind') !== 'message' ||
    positiveLocalId(source.data?.chatId) !== chatId
  ) {
    return null;
  }
  const style = source.android?.style;
  if (style?.type !== AndroidStyle.MESSAGING || style.messages.length < 1) return null;

  // Notifications written just before this upgrade contain one safe local messageId but no
  // parallel history list. Adopt that exact one-line shape; any multi-line unowned shape fails.
  const encodedIds = source.data?.[MESSAGE_HISTORY_IDS_KEY];
  const ids =
    encodedIds == null && style.messages.length === 1
      ? [positiveLocalId(source.data?.messageId)]
      : decodeMessageHistoryIds(encodedIds, style.messages.length);
  if (!ids || ids.some((id) => id == null)) return null;

  const entries: MessageNotificationHistoryEntry[] = [];
  for (let index = 0; index < style.messages.length; index += 1) {
    const line = style.messages[index];
    const messageId = ids[index];
    const icon = line?.person?.icon;
    if (
      messageId == null ||
      typeof line?.text !== 'string' ||
      line.text.length === 0 ||
      typeof line.timestamp !== 'number' ||
      !Number.isFinite(line.timestamp) ||
      typeof line.person?.name !== 'string' ||
      line.person.name.length === 0 ||
      line.person.id !== 'contact' ||
      (icon != null && (typeof icon !== 'string' || icon.length === 0))
    ) {
      return null;
    }
    entries.push({
      messageId,
      text: line.text,
      timestamp: line.timestamp,
      senderName: line.person.name,
      ...(typeof icon === 'string' ? { avatarUri: icon } : {}),
    });
  }

  const title = typeof source.title === 'string' && source.title.length > 0 ? source.title : null;
  const channelId = source.android?.channelId;
  if (!title || typeof channelId !== 'string' || channelId.length === 0) return null;
  return { entries, title, channelId, isGroup: style.group === true };
}

function findDisplayedMessageHistory(
  displayed: readonly DisplayedNotification[],
  chatId: number,
): DisplayedMessageHistory | null {
  const id = chatNotificationId(chatId);
  const matches = displayed.filter((item) => notificationId(item.notification, item.id) === id);
  return matches.length === 1 ? parseDisplayedMessageHistory(matches[0]!, chatId) : null;
}

function markerKind(source: Notification): string | undefined {
  return dataString(source.data, 'gatorOwner') === NOTIFICATION_DATA_OWNER &&
    dataString(source.data, 'gatorSchema') === NOTIFICATION_DATA_SCHEMA
    ? dataString(source.data, 'gatorKind')
    : undefined;
}

function isReminderPayload(source: Notification): boolean {
  return markerKind(source) === 'reminder' || dataString(source.data, 'reminder') === '1';
}

async function sanitizedMessageNotification(source: Notification): Promise<Notification | null> {
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || resolved.reminder === '1' || resolved.faceTimeUuid) return null;
  const route = await localRouteForGuids(resolved.chatGuid, resolved.messageGuid);
  if (!route) return null;
  const messageDate = resolved.messageDate;
  const parsedDate = messageDate == null ? Number.NaN : Number(messageDate);
  const style = source.android?.style;
  const isGroup = style?.type === AndroidStyle.MESSAGING && style.group === true;
  const existingTimestamp =
    style?.type === AndroidStyle.MESSAGING ? style.messages.at(0)?.timestamp : undefined;
  const timestamp = Number.isFinite(parsedDate)
    ? parsedDate
    : typeof existingTimestamp === 'number' && Number.isFinite(existingTimestamp)
      ? existingTimestamp
      : Date.now();
  return {
    id: chatNotificationId(route.chatId),
    title: 'Contact',
    body: 'New message',
    data: {
      ...nativeRouteData(
        'message',
        route,
        messageDate && Number.isFinite(parsedDate) ? messageDate : undefined,
      ),
      ...(route.messageId == null
        ? {}
        : messageHistoryData([
            {
              messageId: route.messageId,
              text: 'New message',
              timestamp,
              senderName: 'Contact',
            },
          ])),
    },
    android: {
      // Legacy cleanup cannot safely recover the conversation title, so use the shared generic
      // channel. Fresh ordinary notifications can still use an existing per-chat channel.
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You', id: 'self' },
        group: isGroup,
        messages: [
          {
            text: 'New message',
            timestamp,
            person: { name: 'Contact', id: 'contact' },
          },
        ],
      },
      actions: messageActions(route.messageId != null),
    },
  };
}

function fixedSendFailureNotification(
  route: NonNullable<Awaited<ReturnType<typeof localFailedMessageRoute>>>['route'],
): Notification {
  return {
    id: sendFailureNotificationId(route.messageId),
    title: SEND_FAILURE_TITLE,
    body: SEND_FAILURE_BODY,
    data: nativeRouteData('send-failure', route),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  };
}

async function sanitizedSendFailureNotification(
  source: Notification,
): Promise<Notification | null> {
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || !resolved.messageGuid) return null;
  const target = await localFailedMessageRoute(resolved.messageGuid);
  if (!target || target.chatGuid !== resolved.chatGuid) return null;
  return fixedSendFailureNotification(target.route);
}

async function sanitizedFaceTimeNotification(
  source: Notification,
  context?: EventDeliveryContext,
): Promise<Notification | null> {
  if (!deliveryIsCurrent(context)) return null;
  const uuid = (await resolveNotificationData(source.data))?.faceTimeUuid;
  if (!deliveryIsCurrent(context)) return null;
  if (!uuid) return null;
  const token = await getOrCreateFaceTimeRoute(
    uuid,
    context ? () => context.isCurrent() : undefined,
  );
  if (!deliveryIsCurrent(context)) return null;

  return {
    id: faceTimeNotificationId(token),
    title: source.title === 'Incoming FaceTime Audio' ? source.title : 'Incoming FaceTime',
    body: 'Incoming call',
    data: nativeFaceTimeData(token),
    android: {
      channelId: CHANNEL_FACETIME,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
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
  };
}

interface ReminderReplacement {
  notification: Notification;
  oldId: string;
  newId: string;
}

interface ReminderTriggerPlan {
  reminder: ReminderReplacement;
  trigger: TimestampTrigger;
}

async function sanitizedReminderNotification(
  source: Notification,
  displayedId?: string,
  scheduledFor?: number,
): Promise<ReminderReplacement | null> {
  const oldId = notificationId(source, displayedId);
  if (!oldId) return null;
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || resolved.reminder !== '1') return null;
  const route = await localRouteForGuids(resolved.chatGuid, resolved.messageGuid);
  if (!route) return null;
  const safeId = isSafeReminderNotificationId(oldId)
    ? oldId
    : resolved.messageGuid
      ? await replacementReminderNotificationId(oldId, resolved.messageGuid, scheduledFor)
      : null;
  if (!safeId) return null;
  const messageDate = resolved.messageDate;
  return {
    oldId,
    newId: safeId,
    notification: {
      id: safeId,
      title: 'Reminder',
      body: 'Reminder',
      data: nativeRouteData(
        'reminder',
        route,
        messageDate && Number.isFinite(Number(messageDate)) ? messageDate : undefined,
      ),
      android: {
        channelId: CHANNEL_REMINDERS,
        smallIcon: 'ic_stat_gator',
        onlyAlertOnce: true,
        pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
      },
    },
  };
}

function sanitizedDurableReminderNotification(
  durable: Awaited<ReturnType<typeof listFutureReminderTriggerRoutes>>[number],
): ReminderTriggerPlan {
  return {
    reminder: {
      oldId: durable.oldId,
      newId: durable.newId,
      notification: {
        id: durable.newId,
        title: 'Reminder',
        body: 'Reminder',
        data: nativeRouteData('reminder', durable.route, durable.messageDate),
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_stat_gator',
          onlyAlertOnce: true,
          pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
        },
      },
    },
    trigger: {
      type: TriggerType.TIMESTAMP,
      timestamp: durable.scheduledFor,
      alarmManager: { type: AlarmType.SET_AND_ALLOW_WHILE_IDLE },
    },
  };
}

/** Preserve designated non-private notices while stripping any unexpected extra presentation. */
function preservedStatusNotification(id: string): Notification | null {
  let title: string;
  let body: string;
  let kind: 'locked' | 'rcs' | 'test' | 'alias';
  switch (id) {
    case STATUS_LOCKED_ID:
      title = 'Gator';
      body = 'You have new messages';
      kind = 'locked';
      break;
    case STATUS_RCS_ID:
      title = 'Gator';
      body = 'RCS service needs attention.';
      kind = 'rcs';
      break;
    case STATUS_TEST_ID:
      title = 'Gator';
      body = 'Test notification received.';
      kind = 'test';
      break;
    case STATUS_ALIAS_ID:
      title = 'iMessage';
      body = 'An iMessage alias was deregistered.';
      kind = 'alias';
      break;
    default:
      return null;
  }
  return {
    id,
    title,
    body,
    data: nativeStatusData(kind),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  };
}

async function sanitizedNotification(
  source: Notification,
  displayedId?: string,
  context?: EventDeliveryContext,
): Promise<Notification | null> {
  const id = notificationId(source, displayedId);
  if (!id) return null;
  const status = preservedStatusNotification(id);
  if (status) return status;
  const kind = markerKind(source);
  const reminder = await sanitizedReminderNotification(source, displayedId);
  if (reminder) return reminder.notification;
  const faceTime =
    kind === 'facetime' || dataString(source.data, 'faceTimeUuid')
      ? await sanitizedFaceTimeNotification(source, context)
      : null;
  if (faceTime) return faceTime;
  if (kind === 'send-failure') return sanitizedSendFailureNotification(source);
  return sanitizedMessageNotification(source);
}

function isTimestampTrigger(value: unknown): value is TimestampTrigger {
  if (typeof value !== 'object' || value == null) return false;
  const trigger = value as Partial<TimestampTrigger>;
  return trigger.type === TriggerType.TIMESTAMP && Number.isFinite(trigger.timestamp);
}

function privacyError(message: string, failures: unknown[]): Error {
  const details = failures.map((failure) => String(failure)).join('; ');
  return new Error(`${message}${details ? ` (${details})` : ''}`);
}

async function sanitizeDisplayedNotifications(context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (enumerationError) {
    try {
      await notifee.cancelDisplayedNotifications();
    } catch (cancelError) {
      throw privacyError('could not enumerate or contain displayed notifications', [
        enumerationError,
        cancelError,
      ]);
    }
    throw privacyError(
      'displayed notifications were cancelled because they could not be enumerated safely',
      [enumerationError],
    );
  }

  const failures: unknown[] = [];
  const plans: Notification[] = [];
  for (const item of displayed) {
    if (!deliveryIsCurrent(context)) return;
    try {
      const reminder = await sanitizedReminderNotification(item.notification, item.id);
      if (!deliveryIsCurrent(context)) return;
      if (reminder) {
        if (
          !(await migrateReminderNotificationId(
            reminder.oldId,
            reminder.newId,
            context ? () => context.isCurrent() : undefined,
          ))
        ) {
          failures.push(new Error('a displayed reminder has no durable row'));
          continue;
        }
        plans.push(reminder.notification);
        continue;
      }
      if (isReminderPayload(item.notification)) {
        failures.push(new Error('a displayed reminder could not be reconciled to its durable row'));
        continue;
      }
      const replacement = await sanitizedNotification(item.notification, item.id, context);
      if (replacement) plans.push(replacement);
    } catch (error) {
      failures.push(error);
    }
  }

  // notify-kit's Android targeted cancel needs the original tag. Store-wide cancellation is the
  // only reliable containment for tagged entries, and it also catches an alarm that fired after
  // enumeration but before this final sweep.
  if (!deliveryIsCurrent(context)) return;
  try {
    await notifee.cancelDisplayedNotifications();
  } catch (error) {
    throw privacyError('could not contain displayed notifications before rebuilding', [error]);
  }
  for (const replacement of plans) {
    if (!deliveryIsCurrent(context)) return;
    try {
      await notifee.displayNotification(replacement);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw privacyError(
      'one or more displayed notifications could not be preserved safely',
      failures,
    );
  }
}

async function armSanitizedReminder(
  { reminder, trigger }: ReminderTriggerPlan,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  try {
    await notifee.createTriggerNotification(reminder.notification, trigger);
  } catch (createError) {
    // A rejected bridge call is not proof that Android made no change. The id and payload are safe,
    // but cancel the uncertain result before retrying so we never leave an untracked native alarm.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch (cancelError) {
      throw privacyError('could not clean up an uncertain reminder re-arm', [
        createError,
        cancelError,
      ]);
    }
    throw createError;
  }

  if (!deliveryIsCurrent(context)) {
    // Disconnect will also queue a store-wide cancel, but retire this just-created alarm while the
    // maintenance slot is still admitted so it cannot survive if account cleanup later degrades.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch {
      // The account owner is already gone; its queued teardown remains the authoritative sweep.
    }
    return;
  }

  try {
    if (
      !(await migrateReminderNotificationId(
        reminder.oldId,
        reminder.newId,
        context ? () => context.isCurrent() : undefined,
      ))
    ) {
      throw new Error('a scheduled reminder has no durable row');
    }
  } catch (migrationError) {
    // The native half must not outlive a failed durable hand-off. This is a direct native call:
    // the enclosing maintenance pass already owns the notification queue slot.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch (cancelError) {
      throw privacyError('could not retire a reminder after its durable hand-off failed', [
        migrationError,
        cancelError,
      ]);
    }
    throw migrationError;
  }
}

/**
 * Native trigger replacement is not transactional. Retry only the failed safe plans once: this
 * repairs the ordinary transient/partial failure without replaying successful alarms, while a
 * persistent failure still rejects promptly instead of wedging the global notification queue.
 */
async function armSanitizedReminders(
  plans: ReminderTriggerPlan[],
  context?: EventDeliveryContext,
): Promise<unknown[]> {
  let remaining = plans;
  let lastFailures: unknown[] = [];
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
    const failedPlans: ReminderTriggerPlan[] = [];
    lastFailures = [];
    for (const plan of remaining) {
      if (!deliveryIsCurrent(context)) return [];
      try {
        await armSanitizedReminder(plan, context);
      } catch (error) {
        failedPlans.push(plan);
        lastFailures.push(error);
      }
    }
    remaining = failedPlans;
  }
  return lastFailures;
}

/**
 * Repair only the native half of future reminders that still exist in the encrypted DB.
 *
 * This ordinary boot path must be non-destructive: existing native alarms may contain the user's
 * normal full preview, so do not globally cancel/rebuild them. A durable row counts as present
 * under either its old or replacement id; otherwise create one generic safe trigger and perform
 * the same durable id hand-off/uncertain-create cleanup as the legacy migration rebuild.
 */
async function repairMissingFutureReminderTriggers(
  pending: TriggerNotification[],
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const nativeIds = new Set(
    pending
      .map((item) => notificationId(item.notification))
      .filter((id): id is string => id != null),
  );

  let durableReminders: Awaited<ReturnType<typeof listFutureReminderTriggerRoutes>>;
  try {
    durableReminders = await listFutureReminderTriggerRoutes();
  } catch (error) {
    throw privacyError('could not inspect durable reminders for missing native alarms', [error]);
  }
  if (!deliveryIsCurrent(context)) return;

  const missingPlans = new Map<string, ReminderTriggerPlan>();
  for (const durable of durableReminders) {
    if (nativeIds.has(durable.oldId) || nativeIds.has(durable.newId)) continue;
    const plan = sanitizedDurableReminderNotification(durable);
    missingPlans.set(plan.reminder.newId, plan);
  }

  const failures = await armSanitizedReminders([...missingPlans.values()], context);
  if (failures.length > 0) {
    throw privacyError(
      'one or more missing scheduled notifications could not be repaired',
      failures,
    );
  }
}

async function sanitizeTriggerNotifications(context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let pending: TriggerNotification[];
  try {
    pending = await notifee.getTriggerNotifications();
  } catch (enumerationError) {
    try {
      await notifee.cancelTriggerNotifications();
    } catch (cancelError) {
      throw privacyError('could not enumerate or contain scheduled notifications', [
        enumerationError,
        cancelError,
      ]);
    }
    throw privacyError(
      'scheduled notifications were cancelled because they could not be enumerated safely',
      [enumerationError],
    );
  }

  const failures: unknown[] = [];
  const plans = new Map<string, ReminderTriggerPlan>();
  for (const item of pending) {
    if (!deliveryIsCurrent(context)) return;
    const trigger = isTimestampTrigger(item.trigger) ? item.trigger : null;
    if (!trigger) continue;
    try {
      const reminder = await sanitizedReminderNotification(
        item.notification,
        undefined,
        trigger.timestamp,
      );
      if (!deliveryIsCurrent(context)) return;
      if (reminder) plans.set(reminder.newId, { reminder, trigger });
      else if (isReminderPayload(item.notification)) {
        failures.push(new Error('a scheduled reminder could not be reconciled to its durable row'));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (!deliveryIsCurrent(context)) return;
  try {
    // Android's trigger list cannot reveal an alarm lost by an earlier failed rebuild. Merge in
    // every future encrypted-DB reminder so this maintenance pass repairs that missing native half.
    for (const durable of await listFutureReminderTriggerRoutes()) {
      const plan = sanitizedDurableReminderNotification(durable);
      plans.set(plan.reminder.newId, plan);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await notifee.cancelTriggerNotifications();
  } catch (error) {
    throw privacyError('could not contain scheduled notifications before rebuilding', [error]);
  }
  failures.push(...(await armSanitizedReminders([...plans.values()], context)));

  if (failures.length > 0) {
    throw privacyError(
      'one or more scheduled notifications could not be preserved safely',
      failures,
    );
  }
}

function carriesLegacyRawRoute(source: Notification): boolean {
  // Schema-2 payloads contain only local integer keys/random tokens. Older payloads had no owner
  // marker and placed server GUIDs, phone/email-bearing chat ids, message GUIDs or call UUIDs in
  // Android-persisted data. Positively identify only that legacy shape; ordinary current payloads
  // must not be rebuilt merely because startup maintenance runs.
  if (markerKind(source) != null) return false;
  return ['chatGuid', 'messageGuid', 'faceTimeUuid'].some(
    (key) => dataString(source.data, key) != null,
  );
}

/** One-time upgrade containment for native payloads written before opaque schema-2 routes. */
async function sanitizeLegacyNotificationPayloadsIfPresent(
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const [displayedResult, triggersResult] = await Promise.allSettled([
    notifee.getDisplayedNotifications(),
    notifee.getTriggerNotifications(),
  ]);
  if (!deliveryIsCurrent(context)) return;
  if (displayedResult.status === 'rejected' || triggersResult.status === 'rejected') {
    const inspectionFailures = [displayedResult, triggersResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    const containmentFailures: unknown[] = [];
    // Stop pending alarms first, then sweep the tray last so an alarm that fires during
    // containment cannot leave a legacy payload displayed.
    try {
      await notifee.cancelTriggerNotifications();
    } catch (error) {
      containmentFailures.push(error);
    }
    try {
      await notifee.cancelDisplayedNotifications();
    } catch (error) {
      containmentFailures.push(error);
    }
    if (containmentFailures.length > 0) {
      throw privacyError('could not inspect or fully contain legacy notification state', [
        ...inspectionFailures,
        ...containmentFailures,
      ]);
    }
    throw privacyError(
      'notification state was cancelled because legacy payloads could not be inspected safely',
      inspectionFailures,
    );
  }
  const displayed = displayedResult.value;
  const triggers = triggersResult.value;

  const hasLegacy =
    displayed.some((item) => carriesLegacyRawRoute(item.notification)) ||
    triggers.some((item) => carriesLegacyRawRoute(item.notification));
  if (!hasLegacy) {
    // An interrupted older cleanup can cancel a native trigger before re-arming it. The durable row
    // is still authoritative, so reuse the enumeration above and restore only absent alarms; never
    // disturb alarms already present.
    await repairMissingFutureReminderTriggers(triggers, context);
    return;
  }

  // Reuse the sanitized whitelist rebuild. This may make notifications already in the tray generic
  // for this one upgrade pass; future posts use fresh full content. Eliminating raw account
  // identifiers from OS state is the safer migration trade-off.
  const failures: unknown[] = [];
  try {
    await sanitizeTriggerNotifications(context);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    await sanitizeDisplayedNotifications(context);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw privacyError(
      'legacy notification migration completed with containment failures',
      failures,
    );
  }
}

async function sanitizePerChatChannels(
  genericizeSafeChannelNames: boolean,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const failures: unknown[] = [];
  const prefix = `${CHANNEL_NEW_MESSAGE}.chat.`;
  const safePrefix = `${prefix}route_`;
  let channels: Awaited<ReturnType<typeof notifee.getChannels>>;
  try {
    channels = await notifee.getChannels();
  } catch (error) {
    throw privacyError('could not enumerate conversation channels', [error]);
  }
  if (!deliveryIsCurrent(context)) return;
  for (const channel of channels) {
    if (!deliveryIsCurrent(context)) return;
    if (!channel.id.startsWith(prefix)) continue;
    const localRouteSuffix = channel.id.startsWith(safePrefix)
      ? channel.id.slice(safePrefix.length)
      : '';
    const isSafeLocalRoute = /^[1-9]\d*$/.test(localRouteSuffix);
    try {
      if (isSafeLocalRoute) {
        if (!genericizeSafeChannelNames) continue;
        await notifee.createChannel({
          id: channel.id,
          name: 'Conversation',
          importance: channel.importance,
        });
      } else {
        // Legacy ids were derived from a raw chat GUID and cannot be made private in place.
        await notifee.deleteChannel(channel.id);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw privacyError('could not sanitize conversation channels', failures);
}

/**
 * Keep legacy Android payload/channel cleanup and durable reminder repair together. The caller
 * already owns the native queue slot; run both idempotent maintenance halves so a failure in one
 * does not prevent the other from being tried.
 */
async function prepareNotificationPresentationStateNow(
  context?: EventDeliveryContext,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await sanitizeLegacyNotificationPayloadsIfPresent(context);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    await sanitizePerChatChannels(false, context);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw privacyError('notification presentation maintenance completed with failures', failures);
  }
}

/**
 * Run one ordinary connected-account startup maintenance pass after foreground boot has admitted
 * its encrypted DB. Capture ownership before joining the native queue: a pass that waits behind
 * Disconnect is dropped, while an admitted pass is visible to Disconnect's drain and cannot commit
 * a reminder-id handoff after its original account is revoked.
 */
export function prepareNotificationPresentationState(): Promise<void> {
  const accountLease = captureRealtimeDeliveryLease();
  return enqueueNotificationOperation(async () => {
    try {
      await runTrackedRealtimeWork(accountLease, (activeLease) =>
        prepareNotificationPresentationStateNow(activeLease),
      );
    } catch (error) {
      if (!accountLease.isCurrent()) return;
      throw error;
    }
  });
}

// Fallback avatar for a sender with no contact photo: the Gator mark, so the notification shows
// our icon instead of Android's generic gray silhouette. Resolve it only when the first message
// notification needs it; importing notification operations must not touch React Native's asset
// registry. Guarded because resolveAssetSource can return undefined and notify-kit throws on
// `icon: undefined`.
let gatorAvatarResolved = false;
let gatorAvatarUri: string | undefined;

function getGatorAvatarUri(): string | undefined {
  if (gatorAvatarResolved) return gatorAvatarUri;
  gatorAvatarResolved = true;
  try {
    // Literal requires keep both dependencies in Metro while avoiding a static React Native import
    // in React-free Node graphs. Any failure simply omits the optional fallback avatar.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- static RN import breaks the React-free node/headless import path
    const { Image } = require('react-native') as typeof import('react-native');
    gatorAvatarUri = Image.resolveAssetSource(
      require('../../../assets/notification-avatar.png') as number,
    )?.uri;
  } catch {
    gatorAvatarUri = undefined;
  }
  return gatorAvatarUri;
}

let channelReady: Promise<string> | null = null;
function ensureChannel(): Promise<string> {
  // Don't memoize a REJECTED promise — clear the cache on failure so a later call retries.
  // Without this reset, one transient createChannel failure poisoned the cache for the whole JS
  // context: every subsequent postNotification awaited the same rejected promise and threw, so
  // message notifications stopped permanently until the app was restarted. (The FaceTime and
  // Reminder channels below always had this guard; the main one silently did not.)
  channelReady ??= notifee
    .createChannel({
      id: CHANNEL_NEW_MESSAGE,
      name: 'New Messages',
      importance: AndroidImportance.HIGH,
    })
    .catch((e) => {
      channelReady = null;
      throw e;
    });
  return channelReady;
}

function deliveryIsCurrent(context?: EventDeliveryContext): boolean {
  return context?.isCurrent() ?? true;
}

function privateNotificationMustBeHidden(): boolean {
  return effectivelyLocked(useLockStore.getState(), false);
}

async function containPrivateNotificationIfLocked(
  context?: EventDeliveryContext,
): Promise<boolean> {
  if (!privateNotificationMustBeHidden()) return false;
  await postStatusNotification(
    STATUS_LOCKED_ID,
    'locked',
    'Gator',
    'You have new messages',
    context,
  );
  return true;
}

/**
 * Post a fixed-id, content-less STATUS notification (server notices + the app-locked placeholder).
 * A stable id means repeated posts update in place instead of stacking. These carry no private
 * message routing data. RCS/self-test text is app-authored rather than trusted from the server;
 * alias text is user-visible content supplied by its ordinary detailed caller.
 */
async function postStatusNotification(
  id: string,
  kind: 'locked' | 'rcs' | 'test' | 'alias',
  title: string,
  body: string,
  context?: EventDeliveryContext,
  hidePrivateWhenLocked = false,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  const hidePrivate = hidePrivateWhenLocked && privateNotificationMustBeHidden();
  await notifee.displayNotification({
    id: hidePrivate ? STATUS_LOCKED_ID : id,
    title: hidePrivate ? 'Gator' : title,
    body: hidePrivate ? 'You have new messages' : body,
    data: nativeStatusData(hidePrivate ? 'locked' : kind),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  });
}

/** Stable channel id derived only from a local integer key (never a phone/email-bearing GUID). */
export function chatChannelId(chatId: number): string {
  return chatChannelIdForLocalId(chatId);
}

/**
 * Create a per-conversation notification channel (if absent) and open its Android system settings,
 * so the user can set a custom sound / importance / vibration for THIS chat. Once created, that
 * chat's message notifications route to it (see `postNotification`). Parity with the old app's
 * per-chat "Notification Settings" tile. Android-only; a no-op elsewhere.
 */
export function openChatNotificationSettings(
  chatGuid: string,
  title: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(async () => {
    if (!deliveryIsCurrent(context)) return;
    const route = await localRouteForGuids(chatGuid);
    if (!deliveryIsCurrent(context)) return;
    if (!route) throw new Error('cannot open notification settings for an unknown conversation');
    const id = chatChannelId(route.chatId);
    await notifee.createChannel({
      id,
      name: title || 'Conversation',
      importance: AndroidImportance.HIGH,
    });
    if (!deliveryIsCurrent(context)) return;
    await notifee.openNotificationSettings(id);
  });
}

export type NotificationPermissionState = 'not-determined' | 'denied' | 'granted';

function notificationPermissionState(status: AuthorizationStatus): NotificationPermissionState {
  if (status >= AuthorizationStatus.AUTHORIZED) return 'granted';
  return status === AuthorizationStatus.NOT_DETERMINED ? 'not-determined' : 'denied';
}

/** Read notification access without showing Android's permission prompt. */
export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const settings = await notifee.getNotificationSettings();
  return notificationPermissionState(settings.authorizationStatus);
}

/** Request POST_NOTIFICATIONS (Android 13+) after the app has explained why. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return notificationPermissionState(settings.authorizationStatus) === 'granted';
}

/** Open this app's Android notification controls for denied/permanently denied recovery. */
export function openNotificationPermissionSettings(): Promise<void> {
  return notifee.openNotificationSettings();
}

/**
 * Show (or, for a cancel intent, clear) a chat notification. One notification
 * per chat (id = a local chat key) so a newer message updates it in place. Uses the
 * Android MESSAGING style so it threads with sender + avatar; carries inline
 * Reply + Mark-as-read actions handled by `handleNotificationAction`.
 */
export function postNotification(
  intent: NotificationIntent,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(async () => {
    // A realtime event can sit behind account cleanup in this queue. Check its account lease at
    // the actual native-mutation boundary, not only before it joined the queue, so Disconnect
    // cannot let an old account post after queued teardown.
    if (context && !context.isCurrent()) return;
    await postNotificationNow(intent, context);
  });
}

/** Private, already-running-in-the-queue adapter. Do not call exported queued helpers from here. */
async function postNotificationNow(
  intent: NotificationIntent,
  context?: EventDeliveryContext,
  routeDb?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  // Defense in depth for the common socket/FCM pipeline. The AppState coordinator normally keeps
  // the socket disconnected while locked, but an event already queued at the boundary must still
  // never render sender/title/body over the lock screen. The timestamp check closes the tiny window
  // before the UI listener has flipped `locked` on a warm resume.
  if (
    (intent.kind === 'message' ||
      intent.kind === 'send-failure' ||
      intent.kind === 'facetime-call' ||
      intent.kind === 'alias-removed') &&
    privateNotificationMustBeHidden()
  ) {
    await postStatusNotification(
      STATUS_LOCKED_ID,
      'locked',
      'Gator',
      'You have new messages',
      context,
    );
    return;
  }
  if (intent.kind === 'cancel') {
    await cancelForChatNow(intent.chatGuid, context);
    return;
  }
  if (intent.kind === 'message-withdraw') {
    await withdrawMessageNotificationNow(intent.chatGuid, intent.messageGuid, context, routeDb);
    return;
  }
  if (intent.kind === 'facetime-cancel') {
    await cancelFaceTimeNotificationNow(intent.uuid, context);
    return;
  }
  if (intent.kind === 'facetime-call') {
    await postFaceTimeNotification(intent, context);
    return;
  }
  if (intent.kind === 'send-failure-cancel') {
    await cancelSendFailureNotificationNow(intent.messageGuid, context, routeDb);
    return;
  }
  if (intent.kind === 'send-failure') {
    await postSendFailureNotificationNow(intent, context, routeDb);
    return;
  }
  if (intent.kind === 'rcs-bridge-down') {
    // The server is not a trusted presentation source. Keep diagnostics generic in OS state.
    await postStatusNotification(
      STATUS_RCS_ID,
      'rcs',
      'Gator',
      'RCS service needs attention.',
      context,
    );
    return;
  }
  if (intent.kind === 'test-notification') {
    // The server's push self-test. Seeing this IS the passing result; suppressing it would make a
    // healthy pipeline look broken, which is the exact failure this probe exists to rule out.
    await postStatusNotification(
      STATUS_TEST_ID,
      'test',
      'Gator',
      'Test notification received.',
      context,
    );
    return;
  }
  if (intent.kind === 'alias-removed') {
    const body =
      intent.aliases.length === 1
        ? `${intent.aliases[0]} has been deregistered.`
        : `Aliases deregistered: ${intent.aliases.join(', ')}`;
    await postStatusNotification(STATUS_ALIAS_ID, 'alias', 'iMessage', body, context, true);
    return;
  }
  // Suppress at the native boundary, not while deriving the intent: another-chat/background and
  // headless delivery still post, while a route that became visible during queued DB work stays
  // quiet. Re-check after every native/DB await below because focus can change between them.
  if (isActiveChat(intent.chatGuid)) return;
  if (!deliveryIsCurrent(context)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const route = await localRouteForGuids(intent.chatGuid, intent.messageGuid);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  if (!route) throw new Error('cannot post a notification for an unknown conversation');
  if (route.messageId == null) {
    throw new Error('cannot post a message notification without an opaque local message id');
  }
  const displayed = await notifee.getDisplayedNotifications();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const existingHistory = findDisplayedMessageHistory(displayed, route.chatId)?.entries ?? [];
  const replacesExistingLine = existingHistory.some((entry) => entry.messageId === route.messageId);
  const avatarUri = intent.avatarUri ?? getGatorAvatarUri();
  const history = mergeMessageNotificationHistory(existingHistory, {
    messageId: route.messageId,
    text: intent.body,
    timestamp: intent.timestamp,
    senderName: intent.senderName,
    ...(avatarUri ? { avatarUri } : {}),
  });
  // A delayed duplicate may already have fallen outside the six-line window. In that case the
  // merge is a no-op, so do not repost unchanged history or alert the user again.
  if (!history.some((entry) => entry.messageId === route.messageId)) return;
  const latest = history.at(-1);
  if (!latest) throw new Error('cannot post an empty message notification history');
  // Route to this chat's OWN channel if the user has customized it (created via
  // openChatNotificationSettings); else the shared "New Messages" channel. getChannel returns null
  // for an uncreated channel, so this is a cheap per-post check with no persisted bookkeeping.
  const perChatId = chatChannelId(route.chatId);
  const customChannel = await notifee.getChannel(perChatId).catch(() => null);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  if (customChannel) {
    // Updating a channel's name preserves the user's sound/importance settings while keeping the
    // current conversation title accurate.
    await notifee.createChannel({
      id: perChatId,
      name: intent.chatTitle || 'Conversation',
      importance: customChannel.importance,
    });
    if (!deliveryIsCurrent(context)) return;
    if (await containPrivateNotificationIfLocked(context)) return;
    if (isActiveChat(intent.chatGuid)) return;
  }
  const channelId = customChannel ? perChatId : CHANNEL_NEW_MESSAGE;
  const title = intent.chatTitle;
  if (!deliveryIsCurrent(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  await notifee.displayNotification({
    id: chatNotificationId(route.chatId),
    title,
    body: latest.text,
    // messageDate lets a notification tap deep-link with ?focusDate so the chat loads a
    // window CENTERED on the message (older messages resolve reliably, not just recent ones).
    data: {
      ...nativeRouteData(
        'message',
        { chatId: route.chatId, messageId: latest.messageId },
        latest.timestamp,
      ),
      ...messageHistoryData(history),
    },
    android: {
      channelId,
      smallIcon: 'ic_stat_gator',
      ...(replacesExistingLine ? { onlyAlertOnce: true } : {}),
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You', id: 'self' },
        group: intent.isGroup,
        // The id inside each Person stays a constant; phone/email handles never enter native data.
        // `messagingStyleLines` also conditionally omits icon instead of passing `undefined`.
        messages: messagingStyleLines(history),
      },
      // Android caps inline actions at ~3; keep Reply + Mark-as-read + one tapback.
      actions: messageActions(true),
    },
  });
}

async function cancelResolvedChatNotificationNow(
  chatGuid: string,
  chatId: number,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  await notifee.cancelNotification(chatNotificationId(chatId));
  if (!deliveryIsCurrent(context)) return;
  // Compatibility cleanup only: new notifications never persist this raw server identifier.
  await notifee.cancelNotification(chatGuid);
}

/** Remove one line by its opaque local id; malformed native history is contained, not guessed. */
async function withdrawMessageNotificationNow(
  chatGuid: string,
  messageGuid: string,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let route = await localRouteForGuids(chatGuid, messageGuid, db);
  if (!deliveryIsCurrent(context)) return;
  if (!route) {
    // A legacy notification may still use the raw chat id even though the encrypted route is gone.
    await notifee.cancelNotification(chatGuid);
    return;
  }
  if (route.messageId == null) {
    const aliasRoute = await localRouteForMessageGuid(messageGuid, db);
    if (!deliveryIsCurrent(context)) return;
    if (aliasRoute?.chatId === route.chatId) route = aliasRoute;
  }
  if (route.messageId == null) {
    await cancelResolvedChatNotificationNow(chatGuid, route.chatId, context);
    return;
  }

  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch {
    // Deletion/retraction privacy wins over history preservation when Android cannot enumerate.
    await cancelResolvedChatNotificationNow(chatGuid, route.chatId, context);
    return;
  }
  if (!deliveryIsCurrent(context)) return;

  const id = chatNotificationId(route.chatId);
  const matches = displayed.filter((item) => notificationId(item.notification, item.id) === id);
  if (matches.length === 0) {
    await notifee.cancelNotification(chatGuid);
    return;
  }
  const current =
    matches.length === 1 ? parseDisplayedMessageHistory(matches[0]!, route.chatId) : null;
  if (!current) {
    await cancelResolvedChatNotificationNow(chatGuid, route.chatId, context);
    return;
  }

  const remaining = removeMessageFromNotificationHistory(current.entries, route.messageId);
  if (remaining.length === current.entries.length) {
    // The target is not in this chat's bounded tray history; leave unrelated lines intact.
    await notifee.cancelNotification(chatGuid);
    return;
  }
  if (remaining.length === 0 || privateNotificationMustBeHidden()) {
    await cancelResolvedChatNotificationNow(chatGuid, route.chatId, context);
    return;
  }

  const latest = remaining.at(-1)!;
  try {
    await notifee.displayNotification({
      id,
      title: current.title,
      body: latest.text,
      data: {
        ...nativeRouteData(
          'message',
          { chatId: route.chatId, messageId: latest.messageId },
          latest.timestamp,
        ),
        ...messageHistoryData(remaining),
      },
      android: {
        channelId: current.channelId,
        smallIcon: 'ic_stat_gator',
        onlyAlertOnce: true,
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
        style: {
          type: AndroidStyle.MESSAGING,
          person: { name: 'You', id: 'self' },
          group: current.isGroup,
          messages: messagingStyleLines(remaining),
        },
        actions: messageActions(true),
      },
    });
  } catch (displayError) {
    // If Android cannot replace the notice, remove the old notice so deleted text cannot remain.
    try {
      // This queue slot still owns the failed old-account mutation. Containment must not be
      // skipped merely because its delivery lease was revoked during the native await.
      await cancelResolvedChatNotificationNow(chatGuid, route.chatId);
    } catch (cancelError) {
      throw privacyError('could not contain a failed message-withdrawal repost', [
        displayError,
        cancelError,
      ]);
    }
    throw privacyError('message-withdrawal repost failed; the old notification was cancelled', [
      displayError,
    ]);
  }
  if (!deliveryIsCurrent(context)) return;
  await notifee.cancelNotification(chatGuid);
}

async function postSendFailureNotificationNow(
  intent: Extract<NotificationIntent, { kind: 'send-failure' }>,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context) || isActiveChat(intent.chatGuid)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const target = await localFailedMessageRoute(intent.messageGuid, db);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (!target || target.chatGuid !== intent.chatGuid || isActiveChat(intent.chatGuid)) return;
  await notifee.displayNotification(fixedSendFailureNotification(target.route));
}

async function cancelSendFailureNotificationNow(
  messageGuid: string,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  // An RCS bridge can acknowledge with the temp guid just after a server error. The repository
  // deliberately keeps that error sticky, so the acknowledgement is not sufficient evidence to
  // withdraw the notice: current encrypted-DB truth must no longer be failed.
  if (await localFailedMessageRoute(messageGuid, db)) return;
  if (!deliveryIsCurrent(context)) return;
  const route = await localRouteForMessageGuid(messageGuid, db);
  if (!deliveryIsCurrent(context) || !route) return;
  await notifee.cancelNotification(sendFailureNotificationId(route.messageId));
}

/** Post fixed app-authored failure copy only after the supplied DB contains a current error row. */
export function postSendFailureNotification(
  db: AppDatabase,
  chatGuid: string,
  messageGuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(() =>
    postNotificationNow({ kind: 'send-failure', chatGuid, messageGuid }, context, db),
  );
}

/** Best-effort exact withdrawal after a retry/ack settles the same local message row. */
export function cancelSendFailureNotification(
  db: AppDatabase,
  messageGuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(() =>
    cancelSendFailureNotificationNow(messageGuid, context, db),
  );
}

export function cancelForChat(chatGuid: string, context?: EventDeliveryContext): Promise<void> {
  return enqueueNotificationOperation(() => cancelForChatNow(chatGuid, context));
}

export function cancelFaceTimeNotification(
  uuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(() => cancelFaceTimeNotificationNow(uuid, context));
}

/** Cancel the exact native id delivered with an action/press, without another DB route lookup. */
export function cancelNotificationById(id: string): Promise<void> {
  return enqueueNotificationOperation(() => notifee.cancelNotification(id));
}

async function cancelForChatNow(chatGuid: string, context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  try {
    const route = await localRouteForGuids(chatGuid);
    if (!deliveryIsCurrent(context)) return;
    if (route) {
      await notifee.cancelNotification(chatNotificationId(route.chatId));
      if (!deliveryIsCurrent(context)) return;
    }
  } catch (error) {
    if (!deliveryIsCurrent(context)) return;
    // A legacy payload still has a directly cancellable raw id. A failed DB open must not stop us
    // reaching that compatibility cleanup (especially in a failing headless action's finally).
    logger.warn('[notif] could not resolve the private chat notification id', error);
  }
  // Backward-compatible cleanup for notifications posted by an older build. New writes never use
  // this raw id; startup legacy maintenance handles persisted tagged entries reliably.
  if (deliveryIsCurrent(context)) await notifee.cancelNotification(chatGuid);
}

async function cancelFaceTimeNotificationNow(
  uuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  try {
    const token = await findFaceTimeRoute(uuid);
    if (!deliveryIsCurrent(context)) return;
    if (token) {
      await notifee.cancelNotification(faceTimeNotificationId(token));
      if (!deliveryIsCurrent(context)) return;
      await deleteFaceTimeRoute(token, context ? () => context.isCurrent() : undefined);
    }
  } catch (error) {
    if (!deliveryIsCurrent(context)) return;
    logger.warn('[notif] could not resolve the private FaceTime notification id', error);
  }
  if (deliveryIsCurrent(context)) await notifee.cancelNotification(`ft-${uuid}`);
}

/** Used by account teardown so it cannot race queued native work and restore stale notices. */
export function cancelAllNotifications(): Promise<void> {
  return enqueueNotificationOperation(async () => {
    const failures: unknown[] = [];
    try {
      await notifee.cancelAllNotifications();
    } catch (error) {
      failures.push(error);
    }
    try {
      // Per-chat channel names are persistent Android state. This runs after every earlier queued
      // post/channel creation, so even one that crossed the account-revocation boundary cannot
      // leave the old conversation title behind. The sanitizer preserves shared channels and the
      // user's settings on safe local-id channels; only legacy raw-identifier channels are removed.
      await sanitizePerChatChannels(true);
    } catch (error) {
      failures.push(error);
    }
    try {
      await clearNotificationRoutes();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw privacyError('could not fully clear notification state', failures);
  });
}

/**
 * A single content-less "you have messages" notification, used when a background push
 * arrives while the app is LOCKED — we do NOT open/decrypt the DB or reveal any sender or
 * content. A fixed id keeps repeated locked pushes from stacking. Tapping opens the app to
 * the lock screen, after which sync delivers the real per-chat notifications.
 */
export function postLockedNotification(context?: EventDeliveryContext): Promise<void> {
  return enqueueNotificationOperation(() =>
    postStatusNotification(STATUS_LOCKED_ID, 'locked', 'Gator', 'You have new messages', context),
  );
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
 * Post an "Incoming FaceTime" heads-up/full-screen notification with Answer + Decline actions.
 * Its native id carries a random route token; the call UUID remains in the encrypted database.
 * Ongoing + high-importance so it rings until answered/declined.
 */
async function postFaceTimeNotification(
  intent: {
    uuid: string;
    callerName: string;
    isAudio: boolean;
    avatarUri?: string;
  },
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  await ensureFaceTimeChannel();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  const token = await getOrCreateFaceTimeRoute(
    intent.uuid,
    context ? () => context.isCurrent() : undefined,
  );
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  await notifee.displayNotification({
    id: faceTimeNotificationId(token),
    title: intent.isAudio ? 'Incoming FaceTime Audio' : 'Incoming FaceTime',
    body: intent.callerName,
    data: nativeFaceTimeData(token),
    android: {
      channelId: CHANNEL_FACETIME,
      smallIcon: 'ic_stat_gator',
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
 * Schedule a one-shot reminder notification. Uses the inexact SET_AND_ALLOW_WHILE_IDLE alarm type,
 * so it needs no SCHEDULE_EXACT_ALARM permission; best-effort timing is fine for reminders.
 */
interface ReminderNotificationArgs {
  notificationId: string;
  chatGuid: string;
  messageGuid: string;
  title: string;
  body: string;
  scheduledFor: number;
  /** The reminded message's timestamp (ms) — carried so a tap deep-links with ?focusDate and
   *  scrolls to the message. Omitted when the message's date is unknown. */
  messageDate?: number;
}

export function scheduleReminderNotification(args: ReminderNotificationArgs): Promise<void> {
  return enqueueNotificationOperation(() => scheduleReminderNotificationNow(args));
}

/** Private, already-running-in-the-queue adapter. */
async function scheduleReminderNotificationNow(args: ReminderNotificationArgs): Promise<void> {
  if (!isSafeReminderNotificationId(args.notificationId)) {
    throw new Error('refusing to persist a reminder notification with a legacy identifier');
  }
  await ensureReminderChannel();
  const route = await localRouteForGuids(args.chatGuid, args.messageGuid);
  if (!route) throw new Error('cannot schedule a reminder for an unknown conversation');
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
        body: args.body,
        data: nativeRouteData('reminder', route, args.messageDate),
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_stat_gator',
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

export function cancelReminderNotification(notificationId: string): Promise<void> {
  return enqueueNotificationOperation(() => notifee.cancelTriggerNotification(notificationId));
}

/** Fire-and-forget cancel — call when a chat is opened/read in the UI. */
export function clearChatNotification(chatGuid: string, context?: EventDeliveryContext): void {
  void cancelForChat(chatGuid, context).catch((error) => {
    if (context && !context.isCurrent()) return;
    logger.warn('[notif] clear chat notification failed', error);
  });
}
